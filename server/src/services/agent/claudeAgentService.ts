import { spawn, type ChildProcess } from "child_process";
import { config } from "../../config.js";
import type { PageContext, JobAttachment } from "../../types.js";
import {
  buildClaudePlanPrompt,
  buildClaudeTaskPrompt,
  PLAN_SYSTEM_PROMPT,
  summarizeToolInput,
  SYSTEM_PROMPT,
  type AgentEventHandler,
  type AgentResult,
} from "./types.js";
import {
  killAgentForJob,
  registerAgentProcess,
  unregisterAgentProcess,
} from "./agentProcessRegistry.js";
import { pickPlanOutput } from "./planSummaryResolver.js";

export { killAgentForJob };

const IS_WINDOWS = process.platform === "win32";

export class AgentAbortedError extends Error {
  constructor() {
    super("Agent 已中止");
    this.name = "AgentAbortedError";
  }
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

function extractTextFromAssistantMessage(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";

  return content
    .filter((block) => block && typeof block === "object" && (block as { type?: string }).type === "text")
    .map((block) => String((block as { text?: string }).text ?? ""))
    .join("");
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
    emitStatus(state, onEvent, "Claude 正在请求模型响应...");
  }

  if (type === "stream_event" && parsed.event && typeof parsed.event === "object") {
    const event = parsed.event as Record<string, unknown>;
    const eventType = String(event.type ?? "");

    if (eventType === "content_block_start") {
      const block = event.content_block as { type?: string; name?: string } | undefined;
      if (block?.type === "thinking") {
        emitStatus(state, onEvent, "Claude 正在思考...");
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
      emitStatus(state, onEvent, "Claude 正在思考...");
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
    return extractTextFromAssistantMessage(parsed.message);
  }

  if (type === "result") {
    const result = parsed.result;
    if (typeof result === "string" && result.trim()) {
      return result.trim();
    }
    const text = extractTextFromAssistantMessage(parsed);
    if (text.trim()) return text.trim();
  }

  return "";
}

function runClaudeCommand(
  args: string[],
  cwd: string,
  stdinText: string,
  jobId?: string,
  onEvent?: AgentEventHandler,
  timeoutMs = config.CLAUDE_TIMEOUT_MS
): Promise<string> {
  return new Promise((resolve, reject) => {
    let aborted = false;
    const child = spawn(config.CLAUDE_CLI_PATH, args, {
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
    const parseState: StreamParseState = {
      seenTools: new Set<string>(),
      lastStatusAt: 0,
      lastStatusText: "",
    };
    let stderr = "";
    let lastActivityAt = Date.now();
    let lastEventLabel = "process started";

    child.stdout.on("data", (chunk: Buffer) => {
      lastActivityAt = Date.now();
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        lastEventLabel = describeStreamLine(trimmed);

        try {
          const parsed = JSON.parse(trimmed) as Record<string, unknown>;
          if (parsed.type === "result") {
            const resultText = typeof parsed.result === "string" ? parsed.result.trim() : "";
            if (resultText) finalSummary = resultText;
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
      lastEventLabel = "stderr";
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      aborted = true;
      killChildProcess(child);
      const idleSeconds = Math.round((Date.now() - lastActivityAt) / 1000);
      const stderrTail = stderr.trim().slice(-300);
      const detail = `最后活动 ${idleSeconds}s 前，最后事件: ${lastEventLabel}`;
      const stderrDetail = stderrTail ? `，stderr: ${stderrTail}` : "";
      reject(new Error(`Claude Code 执行超时（${timeoutMs}ms，${detail}${stderrDetail}）`));
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      if (jobId) unregisterAgentProcess(jobId);
      const hint = IS_WINDOWS
        ? "请确认已安装 Claude Code CLI 且 CLAUDE_CLI_PATH=claude 可用"
        : "请确认已安装 Claude Code CLI，必要时在 .env 设置 CLAUDE_CLI_PATH 为绝对路径";
      reject(new Error(`无法启动 Claude Code CLI: ${err.message}。${hint}`));
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (jobId) unregisterAgentProcess(jobId);

      if (aborted || signal === "SIGTERM" || signal === "SIGKILL") {
        reject(new AgentAbortedError());
        return;
      }

      const tail = buffer.trim();
      if (tail) {
        lastEventLabel = describeStreamLine(tail);
        try {
          const parsed = JSON.parse(tail) as Record<string, unknown>;
          if (parsed.type === "result") {
            const resultText = typeof parsed.result === "string" ? parsed.result.trim() : "";
            if (resultText) finalSummary = resultText;
          }
        } catch {
          // ignore
        }
        handleStreamJsonLine(tail, onEvent, parseState);
      }

      if (code === 0) {
        const output = pickPlanOutput(finalSummary, streamedText);
        resolve(output || "Claude Code 已完成代码修改");
        return;
      }

      const detail = stderr.trim() || streamedText.trim() || `exit code ${code}`;
      reject(new Error(`Claude Code 执行失败: ${detail.slice(0, 500)}`));
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
  options?: {
    permissionMode?: string;
    systemPrompt?: string;
    mode?: "plan" | "execute";
    jobId?: string;
    attachments?: JobAttachment[];
    confirmedPlan?: string;
  }
): Promise<AgentResult> {
  const isPlan = options?.mode === "plan";
  const permissionMode = isPlan
    ? "dontAsk"
    : (options?.permissionMode ?? config.CLAUDE_PERMISSION_MODE);
  const systemPrompt =
    options?.systemPrompt ?? (isPlan ? PLAN_SYSTEM_PROMPT : SYSTEM_PROMPT);
  const userPrompt = isPlan
    ? buildClaudePlanPrompt(prompt, pageContext, options?.attachments)
    : buildClaudeTaskPrompt(prompt, pageContext, options?.attachments, options?.confirmedPlan);

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

  // Plan 模式严禁跳过权限；执行模式可按配置跳过
  if (config.CLAUDE_SKIP_PERMISSIONS && !isPlan) {
    args.splice(1, 0, "--dangerously-skip-permissions");
  }

  if (isPlan) {
    args.push("--allowedTools", "Read,Grep,Glob,WebFetch,WebSearch");
  }

  if (config.CLAUDE_MODEL) {
    args.push("--model", config.CLAUDE_MODEL);
  }

  console.log(
    `[AI Runtime] Claude Code CLI，模式: ${isPlan ? "plan（读仓库出方案）" : "execute（改代码）"}，目录: ${repoPath}`
  );
  console.log(`[AI Runtime] 任务: ${prompt}`);

  const output = await runClaudeCommand(
    args,
    repoPath,
    userPrompt,
    options?.jobId,
    onEvent,
    config.CLAUDE_TIMEOUT_MS
  );

  return {
    summary: output || (isPlan ? "Plan 分析完成" : "Claude Code 已完成代码修改"),
  };
}
