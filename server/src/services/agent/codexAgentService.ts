import { spawn, type ChildProcess } from "child_process";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { config } from "../../config.js";
import type { PageContext } from "../../types.js";
import {
  buildClaudePlanPrompt,
  buildClaudeQuestionPrompt,
  buildClaudeTaskPrompt,
  PLAN_SYSTEM_PROMPT,
  buildQuestionSystemPrompt,
  summarizeToolInput,
  SYSTEM_PROMPT,
  type AgentEventHandler,
  type AgentResult,
  type AgentRunOptions,
} from "./types.js";
import {
  registerAgentProcess,
  unregisterAgentProcess,
} from "./agentProcessRegistry.js";
import { pickPlanOutput } from "./planSummaryResolver.js";
import { AgentAbortedError } from "./errors.js";
import { loadCodexWebSocketOverrides } from "./codexWebSocketOverrides.js";
import { commandActivity } from "./commandActivity.js";
import { CodexQuotaError, isCodexQuotaMessage } from "./providerFallback.js";

export { killAgentForJob } from "./agentProcessRegistry.js";

const IS_WINDOWS = process.platform === "win32";
const CODEX_EXECUTION_PROMPT = [
  "【Codex CLI 执行约束】",
  "这是非交互式代码执行任务，不是方案说明或回答问题。",
  "执行模式下必须实际读取并修改仓库文件，不能只回复“我会、我正在、已定位”。",
  "完成前必须检查 Git 工作区是否已有代码变更；如果没有变更，继续定位和修改，不要提前结束。",
  "最终回复只总结已经实际完成的改动效果。",
].join("\n");

function parseCommaList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function killChildProcess(child: ChildProcess): void {
  if (!child.pid) return;

  if (IS_WINDOWS) {
    try {
      const terminator = spawn("taskkill", ["/F", "/PID", String(child.pid), "/T"], {
        shell: false, windowsHide: true, stdio: "ignore",
      });
      terminator.on("error", () => child.kill("SIGTERM"));
      terminator.unref();
    } catch {
      child.kill("SIGTERM");
    }
    return;
  }

  child.kill("SIGTERM");
}

export interface CodexStreamState {
  seenTools: Set<string>;
  lastStatusAt: number;
  lastStatusText: string;
  failure?: string;
}

function emitStatus(
  state: CodexStreamState,
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join("");
  const record = asRecord(value);
  if (!record) return "";
  if (typeof record.text === "string") return record.text;
  if (typeof record.content === "string") return record.content;
  if (Array.isArray(record.content)) return extractText(record.content);
  if (Array.isArray(record.output)) return extractText(record.output);
  if (Array.isArray(record.messages)) return extractText(record.messages);
  return "";
}

function describeCodexLine(line: string): string {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    return String(parsed.type ?? parsed.event ?? "json");
  } catch {
    return line.slice(0, 120);
  }
}

export function handleCodexJsonLine(
  line: string,
  onEvent: AgentEventHandler | undefined,
  state: CodexStreamState
): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return "";
  }

  const type = String(parsed.type ?? parsed.event ?? "");
  if (type === "error" || type === "turn.failed") {
    const detail = parsed.error ?? parsed.message ?? parsed;
    state.failure = typeof detail === "string" ? detail : JSON.stringify(detail);
  }
  if (type === "turn.completed") state.failure = undefined;
  if (type.includes("turn.started") || type.includes("request")) {
    emitStatus(state, onEvent, "正在请求模型响应...");
  } else if (type.includes("reasoning") || type.includes("thinking")) {
    emitStatus(state, onEvent, "正在思考...");
  } else if (type.includes("exec") || type.includes("command")) {
    emitStatus(state, onEvent, "正在执行命令...");
  }

  const item = asRecord(parsed.item) ?? asRecord(parsed.message) ?? asRecord(parsed.delta);
  const itemType = String(item?.type ?? "");
  if (item && (/(tool|call|exec|command)/i.test(`${type}:${itemType}`) || itemType === "file_change")) {
    const command = item.command ?? item.cmd ?? item.arguments ?? item.input;
    const name = String(item.name ?? (itemType || type || "tool"));
    const done = type === "item.completed" || item.status === "completed" || item.status === "failed";
    const key = `${String(item.id ?? name)}:${done ? "done" : "start"}:${summarizeToolInput(command) ?? ""}`;
    if (!state.seenTools.has(key)) {
      state.seenTools.add(key);
      onEvent?.({ type: "agent_tool", toolAction: done ? "done" : "start", toolName: name,
        toolDetail: JSON.stringify({ activity: itemType === "file_change" ? "修改代码文件" : commandActivity(command),
          failed: item.status === "failed" || (typeof item.exit_code === "number" && item.exit_code !== 0) }) });
    }
  }
  if (itemType === "reasoning") emitStatus(state, onEvent, "正在思考...");

  const deltaText = extractText(parsed.delta);
  if (deltaText) {
    onEvent?.({ type: "agent_text", delta: deltaText });
    return deltaText;
  }

  if (type.includes("completed") || type.includes("message") || type.includes("output")) {
    const text = extractText(item ?? parsed);
    if (text) {
      onEvent?.({ type: "agent_text", delta: text });
      return text;
    }
  }

  return "";
}

function runCodexCommand(
  args: string[],
  cwd: string,
  stdinText: string,
  jobId?: string,
  onEvent?: AgentEventHandler,
  timeoutMs = config.CODEX_TIMEOUT_MS,
  finishOnCompletedTurn = false
): Promise<string> {
  return new Promise((resolve, reject) => {
    let aborted = false;
    let settled = false;
    const child = spawn(config.CODEX_CLI_PATH, args, {
      cwd,
      shell: IS_WINDOWS,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      windowsHide: IS_WINDOWS,
    });

    if (jobId) registerAgentProcess(jobId, child);

    let buffer = "";
    let streamedText = "";
    let finalSummary = "";
    const parseState: CodexStreamState = {
      seenTools: new Set<string>(),
      lastStatusAt: 0,
      lastStatusText: "",
    };
    let stderr = "";
    let lastActivityAt = Date.now();
    let lastEventLabel = "process started";
    const finish = (output: string, terminate = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (jobId) unregisterAgentProcess(jobId);
      if (terminate) killChildProcess(child);
      resolve(output);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (jobId) unregisterAgentProcess(jobId);
      reject(error);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      lastActivityAt = Date.now();
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        lastEventLabel = describeCodexLine(trimmed);
        const extracted = handleCodexJsonLine(trimmed, onEvent, parseState);
        if (extracted) streamedText += extracted;
        try {
          const event = JSON.parse(trimmed) as Record<string, unknown>;
          const item = asRecord(event.item);
          if (event.type === "item.completed" && item?.type === "agent_message") {
            const text = extractText(item).trim();
            if (text) finalSummary = text;
          }
          // A tool-free response is complete at the protocol boundary. The CLI
          // may still be waiting on unrelated background model refresh requests.
          if (finishOnCompletedTurn && event.type === "turn.completed" && !parseState.failure && finalSummary) {
            finish(finalSummary, true);
            return;
          }
        } catch { /* Non-JSON output is ignored by the stream parser as before. */ }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      if (settled) return;
      lastActivityAt = Date.now();
      lastEventLabel = "stderr";
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      if (settled) return;
      aborted = true;
      killChildProcess(child);
      const idleSeconds = Math.round((Date.now() - lastActivityAt) / 1000);
      const stderrTail = stderr.trim().slice(-300);
      const detail = `最后活动 ${idleSeconds}s 前，最后事件: ${lastEventLabel}`;
      const stderrDetail = stderrTail ? `，stderr: ${stderrTail}` : "";
      console.warn(`[AI Runtime] Codex 执行超时（${timeoutMs}ms，${detail}${stderrDetail}）`);
      fail(new Error(finishOnCompletedTurn ? "模型连接或响应超时，请稍后重试。" : "Codex 处理超时，已有工作区修改已保留，请稍后重试。"));
    }, timeoutMs);

    child.on("error", (err) => {
      fail(new Error(`无法启动 Codex CLI: ${err.message}。请确认 CODEX_CLI_PATH 配置可用，并已完成 codex login。`));
    });

    child.on("close", (code, signal) => {
      // A previous process must not unregister a newer turn's process.
      if (settled) return;

      if (aborted || signal === "SIGTERM" || signal === "SIGKILL") {
        fail(new AgentAbortedError());
        return;
      }

      const tail = buffer.trim();
      if (tail) {
        lastEventLabel = describeCodexLine(tail);
        const extracted = handleCodexJsonLine(tail, onEvent, parseState);
        if (extracted) streamedText += extracted;
      }

      if (code === 0 && !parseState.failure) {
        finish(finalSummary || streamedText.trim());
        return;
      }

      const detail = [parseState.failure, stderr.trim()].filter(Boolean).join("\n") || streamedText.trim() || `exit code ${code}`;
      const message = `Codex CLI 执行失败: ${detail.slice(0, 500)}`;
      fail(isCodexQuotaMessage([parseState.failure, stderr].filter(Boolean).join("\n")) ? new CodexQuotaError(message) : new Error(message));
    });

    child.stdin.write(stdinText);
    child.stdin.end();
  });
}

export async function runCodexAgent(
  repoPath: string,
  prompt: string,
  pageContext?: PageContext,
  onEvent?: AgentEventHandler,
  options?: AgentRunOptions
): Promise<AgentResult> {
  const isPlan = options?.mode === "plan";
  const isQuestion = options?.mode === "question";
  const isTestCase = options?.mode === "test-case";
  const isConversation = options?.mode === "conversation";
  const isReadOnly = isPlan || isQuestion || isTestCase || isConversation;
  const systemPrompt =
    options?.systemPrompt ??
    (isPlan ? PLAN_SYSTEM_PROMPT : isQuestion ? buildQuestionSystemPrompt(options?.questionChangeInstructions) : SYSTEM_PROMPT);
  const userPrompt = isTestCase || isConversation
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
          options?.conversationHistory,
          options?.questionChangeInstructions
        )
      : buildClaudeTaskPrompt(
          prompt,
          pageContext,
          options?.attachments,
          options?.confirmedPlan,
          options?.conversationHistory
        );

  const args = [
    "exec",
    "--json",
    "--color",
    "never",
    "--cd",
    repoPath,
    "--ephemeral",
  ];

  if (isConversation) {
    args.push("--skip-git-repo-check", "--disable", "shell_tool", "--disable", "unified_exec", "--disable", "code_mode",
      "--disable", "apps", "--disable", "browser_use", "--disable", "computer_use");
  }

  // Capture the final answer for every mode. JSON event output also contains
  // progress messages and must not be saved as the user's final reply.
  const structuredOutputDir = await mkdtemp(join(tmpdir(), "ai-runtime-codex-output-"));
  const structuredOutputPath = join(structuredOutputDir, "last-message.txt");
  args.push("--output-last-message", structuredOutputPath);
  if (options?.jsonSchema) {
    const schemaPath = join(structuredOutputDir, "schema.json");
    await writeFile(schemaPath, JSON.stringify(options.jsonSchema), "utf8");
    args.push("--output-schema", schemaPath);
  }

  if (config.CODEX_BYPASS_SANDBOX && !isReadOnly) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else if (!isReadOnly && config.CODEX_APPROVE_FOR_ME) {
    args.push("--approve-for-me");
  } else {
    args.push(
      "--sandbox",
      isConversation ? "read-only" : isReadOnly ? config.CODEX_READ_ONLY_SANDBOX_MODE : config.CODEX_SANDBOX_MODE
    );
  }

  for (const feature of parseCommaList(config.CODEX_DISABLED_FEATURES)) {
    args.push("--disable", feature);
  }

  if (config.CODEX_ENABLE_SYSTEM_PROXY) {
    args.push("--enable", "respect_system_proxy");
  }

  if (config.CODEX_DISABLE_WEBSOCKETS) {
    args.push(...await loadCodexWebSocketOverrides());
  }

  if (config.CODEX_MODEL) {
    args.push("--model", config.CODEX_MODEL);
  }

  if (config.CODEX_PROFILE) {
    args.push("--profile", config.CODEX_PROFILE);
  }

  for (const attachment of options?.attachments ?? []) {
    args.push("--image", attachment.path);
  }

  args.push("-");

  console.log(
    `[AI Runtime] Codex CLI，模式: ${
      isConversation
        ? "conversation（意图识别与闲聊）"
        : isPlan
        ? "plan（读仓库出方案）"
        : isTestCase
          ? "test-case（只读生成测试用例）"
          : isQuestion
          ? "question（只读项目问答）"
          : "execute（改代码）"
    }，目录: ${repoPath}`
  );
  if (!isConversation) console.log(`[AI Runtime] 任务: ${prompt}`);

  let output = "";
  try {
    output = await runCodexCommand(
      args,
      repoPath,
      `${systemPrompt}\n\n${isReadOnly ? "" : `${CODEX_EXECUTION_PROMPT}\n\n`}${userPrompt}`,
      options?.jobId,
      onEvent,
      options?.timeoutMs ?? config.CODEX_TIMEOUT_MS,
      isConversation
    );

    if (structuredOutputPath) {
      const structuredOutput = await readFile(structuredOutputPath, "utf8").catch(() => "");
      if (structuredOutput.trim()) output = structuredOutput.trim();
    }
  } finally {
    if (structuredOutputDir) {
      await rm(structuredOutputDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  if (!output.trim() && isTestCase) {
    throw new Error("Codex 执行引擎未返回有效文本");
  }

  return {
    summary: pickPlanOutput(output, output) || (isConversation ? "" : isPlan ? "Plan 分析完成" : isTestCase ? "未获得有效测试用例" : isQuestion ? "未获得有效回答" : "已完成代码修改"),
  };
}
