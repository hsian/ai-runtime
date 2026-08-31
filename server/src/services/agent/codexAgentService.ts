import { spawn, type ChildProcess } from "child_process";
import { config } from "../../config.js";
import type { PageContext } from "../../types.js";
import {
  buildClaudePlanPrompt,
  buildClaudeQuestionPrompt,
  buildClaudeTaskPrompt,
  PLAN_SYSTEM_PROMPT,
  QUESTION_SYSTEM_PROMPT,
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
      spawn("taskkill", ["/F", "/PID", String(child.pid), "/T"], { shell: true, windowsHide: true });
    } catch {
      child.kill("SIGTERM");
    }
    return;
  }

  child.kill("SIGTERM");
}

interface CodexStreamState {
  seenTools: Set<string>;
  lastStatusAt: number;
  lastStatusText: string;
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

function emitToolStart(
  state: CodexStreamState,
  onEvent: AgentEventHandler | undefined,
  toolName: string,
  toolDetail?: unknown
): void {
  const detail = summarizeToolInput(toolDetail);
  const key = `${toolName}:${detail ?? ""}`;
  if (state.seenTools.has(key)) return;
  state.seenTools.add(key);
  onEvent?.({
    type: "agent_tool",
    toolAction: "start",
    toolName,
    toolDetail: detail,
  });
}

function handleCodexJsonLine(
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
  if (type.includes("turn.started") || type.includes("request")) {
    emitStatus(state, onEvent, "正在请求模型响应...");
  } else if (type.includes("reasoning") || type.includes("thinking")) {
    emitStatus(state, onEvent, "正在思考...");
  } else if (type.includes("exec") || type.includes("command")) {
    emitStatus(state, onEvent, "正在执行命令...");
  }

  const item = asRecord(parsed.item) ?? asRecord(parsed.message) ?? asRecord(parsed.delta);
  const itemType = String(item?.type ?? "");
  if (item && /(tool|call|exec|command)/i.test(`${type}:${itemType}`)) {
    const command = item.command ?? item.cmd ?? item.arguments ?? item.input;
    const name = String(item.name ?? (itemType || type || "tool"));
    emitToolStart(state, onEvent, name, command);
  }

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
  timeoutMs = config.CODEX_TIMEOUT_MS
): Promise<string> {
  return new Promise((resolve, reject) => {
    let aborted = false;
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

    child.stdout.on("data", (chunk: Buffer) => {
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
      reject(new Error(`执行超时（${timeoutMs}ms，${detail}${stderrDetail}）`));
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      if (jobId) unregisterAgentProcess(jobId);
      reject(new Error(`无法启动 Codex CLI: ${err.message}。请确认 CODEX_CLI_PATH 配置可用，并已完成 codex login。`));
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
        lastEventLabel = describeCodexLine(tail);
        const extracted = handleCodexJsonLine(tail, onEvent, parseState);
        if (extracted) streamedText += extracted;
      }

      if (code === 0) {
        resolve(finalSummary || streamedText.trim());
        return;
      }

      const detail = stderr.trim() || streamedText.trim() || `exit code ${code}`;
      reject(new Error(`Codex CLI 执行失败: ${detail.slice(0, 500)}`));
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
  const isReadOnly = isPlan || isQuestion;
  const systemPrompt =
    options?.systemPrompt ??
    (isPlan ? PLAN_SYSTEM_PROMPT : isQuestion ? QUESTION_SYSTEM_PROMPT : SYSTEM_PROMPT);
  const userPrompt = isPlan
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
    "exec",
    "--json",
    "--color",
    "never",
    "--cd",
    repoPath,
    "--ephemeral",
  ];

  if (config.CODEX_BYPASS_SANDBOX && !isReadOnly) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else if (!isReadOnly && config.CODEX_APPROVE_FOR_ME) {
    args.push("--approve-for-me");
  } else {
    args.push(
      "--sandbox",
      isReadOnly ? config.CODEX_READ_ONLY_SANDBOX_MODE : config.CODEX_SANDBOX_MODE
    );
  }

  for (const feature of parseCommaList(config.CODEX_DISABLED_FEATURES)) {
    args.push("--disable", feature);
  }

  if (config.CODEX_ENABLE_SYSTEM_PROXY) {
    args.push("--enable", "respect_system_proxy");
  }

  if (config.CODEX_DISABLE_WEBSOCKETS) {
    args.push(
      "-c",
      "model_providers.code-switch.supports_websockets=false"
    );
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
      isPlan
        ? "plan（读仓库出方案）"
        : isQuestion
          ? "question（只读项目问答）"
          : "execute（改代码）"
    }，目录: ${repoPath}`
  );
  console.log(`[AI Runtime] 任务: ${prompt}`);

  const output = await runCodexCommand(
    args,
    repoPath,
    `${systemPrompt}\n\n${isReadOnly ? "" : `${CODEX_EXECUTION_PROMPT}\n\n`}${userPrompt}`,
    options?.jobId,
    onEvent,
    config.CODEX_TIMEOUT_MS
  );

  return {
    summary: pickPlanOutput(output, output) || (isPlan ? "Plan 分析完成" : isQuestion ? "未获得有效回答" : "已完成代码修改"),
  };
}
