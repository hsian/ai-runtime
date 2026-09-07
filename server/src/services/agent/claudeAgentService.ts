import { spawn, type ChildProcess } from "child_process";
import { existsSync } from "fs";
import { dirname, extname, isAbsolute, join } from "path";
import { config } from "../../config.js";
import type {
  ConversationHistoryMessage,
  PageContext,
  JobAttachment,
} from "../../types.js";
import {
  buildClaudePlanPrompt,
  buildClaudeQuestionPrompt,
  buildClaudeTaskPrompt,
  PLAN_SYSTEM_PROMPT,
  QUESTION_SYSTEM_PROMPT,
  summarizeToolInput,
  SYSTEM_PROMPT,
  type AgentEventHandler,
  type AgentRunOptions,
  type AgentResult,
} from "./types.js";
import {
  killAgentForJob,
  registerAgentProcess,
  unregisterAgentProcess,
} from "./agentProcessRegistry.js";
import { pickPlanOutput } from "./planSummaryResolver.js";
import { AgentAbortedError } from "./errors.js";

export { killAgentForJob };

const IS_WINDOWS = process.platform === "win32";

function resolveClaudeLaunch(): { command: string; shell: boolean } {
  if (!IS_WINDOWS) return { command: config.CLAUDE_CLI_PATH, shell: false };

  const configured = config.CLAUDE_CLI_PATH.trim();
  const extension = extname(configured).toLowerCase();
  const candidates: string[] = [];

  if (extension === ".exe") {
    return { command: configured, shell: false };
  }

  if (isAbsolute(configured) && (extension === ".cmd" || extension === ".ps1")) {
    candidates.push(join(dirname(configured), "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"));
  }

  if (["claude", "claude.cmd", "claude.ps1"].includes(configured.toLowerCase()) && process.env.APPDATA) {
    candidates.push(join(process.env.APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"));
  }

  const nativeExecutable = candidates.find((candidate) => existsSync(candidate));
  if (nativeExecutable) return { command: nativeExecutable, shell: false };

  return { command: configured, shell: true };
}

function killChildProcess(child: ChildProcess): void {
  if (!child.pid) return;

  if (IS_WINDOWS) {
    try {
      spawn("taskkill", ["/F", "/PID", String(child.pid), "/T"], { shell: true, windowsHide: true });
    } catch {
      child.kill("SIGTERM");
    }
    return;
  }

  child.kill("SIGTERM");
}

interface StreamParseState {
  seenTools: Set<string>;
  lastStatusAt: number;
  lastStatusText: string;
}

function emitStatus(
  state: StreamParseState,
  onEvent: AgentEventHandler | undefined,
  statusText: string,
  throttleMs = 8_000
): void {
  const now = Date.now();
  if (state.lastStatusText === statusText && now - state.lastStatusAt < throttleMs) return;
  state.lastStatusText = statusText;
  state.lastStatusAt = now;
  onEvent?.({ type: "agent_status", statusText });
}

function describeStreamLine(line: string): string {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const type = String(parsed.type ?? "unknown");
    if (type === "system") {
      const subtype = String(parsed.subtype ?? "");
      const status = String(parsed.status ?? "");
      return [type, subtype, status].filter(Boolean).join(":");
    }
    if (type === "stream_event" && parsed.event && typeof parsed.event === "object") {
      const event = parsed.event as Record<string, unknown>;
      const eventType = String(event.type ?? "unknown");
      const delta = event.delta as { type?: string } | undefined;
      return delta?.type ? `${type}:${eventType}:${delta.type}` : `${type}:${eventType}`;
    }
    return type;
  } catch {
    return line.slice(0, 120);
  }
}

function handleStreamJsonLine(line: string, onEvent: AgentEventHandler | undefined, state: StreamParseState): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return "";
  }

  const type = String(parsed.type ?? "");

  if (type === "system" && parsed.status === "requesting") {
    emitStatus(state, onEvent, "正在请求模型响应...");
  }

  if (type === "stream_event" && parsed.event && typeof parsed.event === "object") {
    const event = parsed.event as Record<string, unknown>;
    const eventType = String(event.type ?? "");

    if (eventType === "content_block_start") {
      const block = event.content_block as { type?: string; name?: string } | undefined;
      if (block?.type === "thinking") {
        emitStatus(state, onEvent, "正在思考...");
      }
      if (block?.type === "tool_use" && block.name) {
        const key = `start:${block.name}`;
        if (!state.seenTools.has(key)) {
          state.seenTools.add(key);
          onEvent?.({ type: "agent_tool", toolAction: "start", toolName: block.name });
        }
      }
    }

    const delta = event.delta as { type?: string; text?: string; thinking?: string } | undefined;
    if (delta?.type === "thinking_delta" && delta.thinking) {
      emitStatus(state, onEvent, "正在思考...");
    }
    if (delta?.type === "text_delta" && delta.text) {
      onEvent?.({ type: "agent_text", delta: delta.text });
      return delta.text;
    }
  }

  if (type === "assistant" && parsed.message) {
    const message = parsed.message as { content?: unknown[] };
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (!block || typeof block !== "object") continue;
        const b = block as { type?: string; name?: string; input?: unknown };
        if (b.type === "tool_use" && b.name) {
          const key = `use:${b.name}:${JSON.stringify(b.input ?? "")}`;
          if (!state.seenTools.has(key)) {
            state.seenTools.add(key);
            onEvent?.({
              type: "agent_tool",
              toolAction: "start",
              toolName: b.name,
              toolDetail: summarizeToolInput(b.input),
            });
          }
        }
      }
    }
    return "";
  }

  if (type === "result") {
    return "";
  }

  return "";
}

function extractStructuredOutput(parsed: Record<string, unknown>): string | undefined {
  if (parsed.type === "result" && parsed.structured_output && typeof parsed.structured_output === "object") {
    return JSON.stringify(parsed.structured_output);
  }
  return undefined;
}

function runClaudeCommand(
  args: string[],
  cwd: string,
  stdinText: string,
  jobId?: string,
  onEvent?: AgentEventHandler,
  timeoutMs = config.CLAUDE_TIMEOUT_MS,
  idleTimeoutMs?: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    let aborted = false;
    const launch = resolveClaudeLaunch();
    if (IS_WINDOWS && launch.shell && args.includes("--json-schema")) {
      reject(new Error("Claude Code 结构化输出需要直接启动 claude.exe；请将 CLAUDE_CLI_PATH 配置为 claude.exe 的完整路径"));
      return;
    }
    const child = spawn(launch.command, args, {
      cwd,
      shell: launch.shell,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      windowsHide: IS_WINDOWS,
    });

    if (jobId) registerAgentProcess(jobId, child);

    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (output: string, terminateProcess = false) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);
      if (jobId) unregisterAgentProcess(jobId);
      if (terminateProcess) killChildProcess(child);
      resolve(output);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);
      if (jobId) unregisterAgentProcess(jobId);
      reject(error);
    };

    let buffer = "";
    let streamedText = "";
    let finalSummary = "";
    let resultError = "";
    const parseState: StreamParseState = {
      seenTools: new Set<string>(),
      lastStatusAt: 0,
      lastStatusText: "",
    };
    let stderr = "";
    let lastActivityAt = Date.now();
    let lastEventLabel = "process started";
    const armIdleTimeout = () => {
      if (!idleTimeoutMs || settled) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        const idleSeconds = Math.round((Date.now() - lastActivityAt) / 1000);
        killChildProcess(child);
        fail(new Error(`执行无响应超时（连续 ${idleSeconds}s 没有新输出，最后事件: ${lastEventLabel}）`));
      }, idleTimeoutMs);
    };
    armIdleTimeout();

    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      lastActivityAt = Date.now();
      armIdleTimeout();
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        lastEventLabel = describeStreamLine(trimmed);

        try {
          const parsed = JSON.parse(trimmed) as Record<string, unknown>;
          const structuredOutput = extractStructuredOutput(parsed);
          if (structuredOutput) {
            finalSummary = structuredOutput;
            finish(structuredOutput);
            return;
          }
          if (parsed.type === "result") {
            const resultText = typeof parsed.result === "string" ? parsed.result.trim() : "";
            if (resultText) finalSummary = resultText;
            if (parsed.is_error === true) {
              const errors = Array.isArray(parsed.errors) ? parsed.errors.join("；") : String(parsed.errors ?? resultText ?? "未知错误");
              resultError = errors;
            }
          }
        } catch {
          // ignore malformed line
        }

        const extracted = handleStreamJsonLine(trimmed, onEvent, parseState);
        if (extracted) {
          streamedText += extracted;
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      lastActivityAt = Date.now();
      armIdleTimeout();
      lastEventLabel = "stderr";
      stderr += chunk.toString();
    });

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        aborted = true;
        killChildProcess(child);
        const idleSeconds = Math.round((Date.now() - lastActivityAt) / 1000);
        const stderrTail = stderr.trim().slice(-300);
        const detail = `最后活动 ${idleSeconds}s 前，最后事件: ${lastEventLabel}`;
        const stderrDetail = stderrTail ? `，stderr: ${stderrTail}` : "";
        fail(new Error(`执行总时长超限（${timeoutMs}ms，${detail}${stderrDetail}）`));
      }, timeoutMs);
    }

    child.on("error", (err) => {
      const hint = IS_WINDOWS
        ? "请确认服务端执行引擎路径配置可用"
        : "请确认服务端已安装执行引擎，必要时在 .env 设置执行引擎绝对路径";
      fail(new Error(`无法启动执行引擎: ${err.message}。${hint}`));
    });

    child.on("close", (code, signal) => {
      if (settled) return;

      if (aborted || signal === "SIGTERM" || signal === "SIGKILL") {
        fail(new AgentAbortedError());
        return;
      }

      const tail = buffer.trim();
      if (tail) {
        lastEventLabel = describeStreamLine(tail);
        try {
          const parsed = JSON.parse(tail) as Record<string, unknown>;
          const structuredOutput = extractStructuredOutput(parsed);
          if (structuredOutput) finalSummary = structuredOutput;
          if (parsed.type === "result") {
            const resultText = typeof parsed.result === "string" ? parsed.result.trim() : "";
            if (resultText) finalSummary = resultText;
            if (parsed.is_error === true) {
              const errors = Array.isArray(parsed.errors) ? parsed.errors.join("；") : String(parsed.errors ?? resultText ?? "未知错误");
              resultError = errors;
            }
          }
        } catch {
          // ignore
        }
        handleStreamJsonLine(tail, onEvent, parseState);
      }

      if (code === 0) {
        const output = pickPlanOutput(finalSummary, streamedText);
        if (!output) {
          fail(new Error(resultError ? `执行失败: ${resultError.slice(0, 500)}` : "执行引擎未返回有效文本"));
          return;
        }
        finish(output);
        return;
      }

      const detail = stderr.trim() || streamedText.trim() || `exit code ${code}`;
      fail(new Error(`执行失败: ${detail.slice(0, 500)}`));
    });

    child.stdin.write(stdinText);
    child.stdin.end();
  });
}

export async function runClaudeAgent(
  repoPath: string,
  prompt: string,
  pageContext?: PageContext,
  onEvent?: AgentEventHandler,
  options?: AgentRunOptions
): Promise<AgentResult> {
  const isPlan = options?.mode === "plan";
  const isQuestion = options?.mode === "question";
  const isTestCase = options?.mode === "test-case";
  const isReadOnly = isPlan || isQuestion || isTestCase;
  const permissionMode = isReadOnly
    ? "dontAsk"
    : (options?.permissionMode ?? config.CLAUDE_PERMISSION_MODE);
  const systemPrompt =
    options?.systemPrompt ??
    (isPlan ? PLAN_SYSTEM_PROMPT : isQuestion ? QUESTION_SYSTEM_PROMPT : SYSTEM_PROMPT);
  const userPrompt = isTestCase
    ? prompt
    : isPlan
    ? buildClaudePlanPrompt(
        prompt,
        pageContext,
        options?.attachments,
        options?.conversationHistory
      )
    : isQuestion
      ? buildClaudeQuestionPrompt(
          prompt,
          pageContext,
          options?.attachments,
          options?.conversationHistory
        )
      : buildClaudeTaskPrompt(
          prompt,
          pageContext,
          options?.attachments,
          options?.confirmedPlan,
          options?.conversationHistory
        );

  const args = [
    "-p",
    "--permission-mode",
    permissionMode,
    "--no-session-persistence",
    "--setting-sources",
    config.CLAUDE_SETTING_SOURCES,
    "--system-prompt",
    systemPrompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
  ];

  // 只读模式严禁跳过权限；执行模式可按配置跳过
  if (config.CLAUDE_SKIP_PERMISSIONS && !isReadOnly) {
    args.splice(1, 0, "--dangerously-skip-permissions");
  }

  if (isTestCase) {
    args.push(
      "--safe-mode",
      "--tools",
      options?.disableTools ? "" : "Read,Grep",
      "--effort",
      config.CLAUDE_TEST_CASE_EFFORT
    );
  } else if (isPlan) {
    args.push("--allowedTools", "Read,Grep,Glob,WebFetch,WebSearch");
  } else if (isQuestion) {
    args.push("--allowedTools", "Read,Grep,Glob");
  }

  const model = isTestCase ? config.CLAUDE_TEST_CASE_MODEL : config.CLAUDE_MODEL;
  if (model) {
    args.push("--model", model);
  }

  if (options?.jsonSchema) {
    args.push("--json-schema", JSON.stringify(options.jsonSchema));
  }

  console.log(
    `[AI Runtime] Claude Code CLI，模式: ${
      isPlan
        ? "plan（读仓库出方案）"
        : isTestCase
          ? "test-case（只读生成测试用例）"
          : isQuestion
          ? "question（只读项目问答）"
          : "execute（改代码）"
    }，目录: ${repoPath}`
  );
  console.log(`[AI Runtime] 任务: ${prompt}`);

  const output = await runClaudeCommand(
    args,
    repoPath,
    userPrompt,
    options?.jobId,
    onEvent,
    isTestCase ? 0 : config.CLAUDE_TIMEOUT_MS,
    isTestCase ? config.CLAUDE_TEST_CASE_IDLE_TIMEOUT_MS : undefined
  );

  return {
    summary: output || (isPlan ? "Plan 分析完成" : isTestCase ? "未获得有效测试用例" : isQuestion ? "未获得有效回答" : "已完成代码修改"),
  };
}
