import { spawn, type ChildProcess } from "child_process";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { config } from "../config.js";
import {
  buildRequirementAnalyzePrompt,
  REQUIREMENT_ANALYZE_SYSTEM_PROMPT,
  type AgentEventHandler,
} from "./agent/types.js";
import {
  killAgentForJob,
  registerAgentProcess,
  unregisterAgentProcess,
} from "./agent/agentProcessRegistry.js";
import type { JobAttachment } from "../types.js";

const IS_WINDOWS = process.platform === "win32";

const CODING_PLACEHOLDER = /^(Claude Code 已完成|Plan 分析完成)$/;

export class RequirementPolishAbortedError extends Error {
  constructor() {
    super("需求整理已取消");
    this.name = "RequirementPolishAbortedError";
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

function extractAssistantText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && typeof b === "object" && (b as { type?: string }).type === "text")
    .map((b) => String((b as { text?: string }).text ?? ""))
    .join("");
}

function parseStreamLine(line: string, onEvent?: AgentEventHandler): {
  text: string;
  parsed?: Record<string, unknown>;
} {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return { text: line };
  }

  const type = String(parsed.type ?? "");

  if (type === "stream_event" && parsed.event && typeof parsed.event === "object") {
    const event = parsed.event as Record<string, unknown>;
    const delta = (event.delta as { type?: string; text?: string } | undefined);
    if (delta?.type === "text_delta" && delta.text) {
      onEvent?.({ type: "agent_text", delta: delta.text });
      return { text: delta.text, parsed };
    }
  }

  if (type === "assistant" && parsed.message) {
    return { text: extractAssistantText(parsed.message), parsed };
  }

  if (type === "result") {
    const result = parsed.result;
    if (typeof result === "string" && result.trim() && !CODING_PLACEHOLDER.test(result.trim())) {
      return { text: result.trim(), parsed };
    }
    return { text: extractAssistantText(parsed.message ?? parsed), parsed };
  }

  return { text: "", parsed };
}

function summarizeClaudeOutput(stdoutTail: string[], stderr: string): string {
  const err = stderr.trim();
  if (err) return err;

  const tail = stdoutTail
    .slice(-5)
    .map((line) => line.slice(0, 300))
    .join("\n")
    .trim();
  if (tail) return `Claude CLI 正常退出，但未解析到整理正文。stdout 尾部:\n${tail}`;

  return "Claude CLI 正常退出，但没有输出整理正文";
}

function normalizePolishedRequirementText(text: string): string {
  let result = text
    .replace(/\[图片(?::[^\]]*)?\]/g, "")
    .replace(/^\s*(图片|配图)\s*$/gm, "")
    .trim();

  // 粘连编号：修改2. 需求描述
  result = result.replace(/([^\n\s\d])(\d{1,2})[.、]\s*/g, "$1\n\n$2. ");
  // 同一行内的后续编号
  result = result.replace(/([^\n])(\d{1,2})[.、]\s+/g, "$1\n\n$2. ");

  return result
    .replace(/^(\d{1,2})[、.]\s*/gm, "$1. ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function runRequirementClaude(
  userPrompt: string,
  attachments: JobAttachment[],
  sessionId?: string,
  onEvent?: AgentEventHandler
): Promise<string> {
  const workDir = mkdtempSync(join(tmpdir(), "ai-runtime-req-"));

  const args = [
    "-p",
    "--permission-mode",
    "dontAsk",
    "--no-session-persistence",
    "--setting-sources",
    "user",
    "--system-prompt",
    REQUIREMENT_ANALYZE_SYSTEM_PROMPT,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
  ];

  // --tools 不能为空字符串（CLI 会报 argument missing）；无配图时不传，有配图时仅 Read
  if (attachments.length > 0) {
    args.push("--tools", "Read");
  }

  if (config.CLAUDE_MODEL) {
    args.push("--model", config.CLAUDE_MODEL);
  }

  return new Promise((resolve, reject) => {
    let aborted = false;
    const child = spawn(config.CLAUDE_CLI_PATH, args, {
      cwd: workDir,
      shell: IS_WINDOWS,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      windowsHide: IS_WINDOWS,
    });

    if (sessionId) registerAgentProcess(sessionId, child);

    let buffer = "";
    let streamedText = "";
    let finalSummary = "";
    let stderr = "";
    const stdoutTail: string[] = [];

    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        stdoutTail.push(trimmed);
        if (stdoutTail.length > 20) stdoutTail.shift();

        const piece = parseStreamLine(trimmed, onEvent);
        if (piece.parsed?.type === "result") {
          const resultText =
            typeof piece.parsed.result === "string" ? piece.parsed.result.trim() : "";
          if (resultText && !CODING_PLACEHOLDER.test(resultText)) {
            finalSummary = resultText;
          }
        }

        if (piece.text && !finalSummary) {
          streamedText += piece.text;
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      aborted = true;
      killChildProcess(child);
      reject(new Error(`需求整理超时（${config.REQUIREMENT_ANALYZE_TIMEOUT_MS}ms）`));
    }, config.REQUIREMENT_ANALYZE_TIMEOUT_MS);

    child.on("error", (err) => {
      clearTimeout(timer);
      if (sessionId) unregisterAgentProcess(sessionId);
      reject(new Error(`无法启动 Claude Code: ${err.message}`));
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (sessionId) unregisterAgentProcess(sessionId);

      if (aborted || signal === "SIGTERM" || signal === "SIGKILL") {
        reject(new RequirementPolishAbortedError());
        return;
      }

      const tail = buffer.trim();
      if (tail) {
        stdoutTail.push(tail);
        if (stdoutTail.length > 20) stdoutTail.shift();

        const piece = parseStreamLine(tail, onEvent);
        if (piece.parsed?.type === "result") {
          const resultText =
            typeof piece.parsed.result === "string" ? piece.parsed.result.trim() : "";
          if (resultText && !CODING_PLACEHOLDER.test(resultText)) {
            finalSummary = resultText;
          }
        }
        if (piece.text && !finalSummary) {
          streamedText += piece.text;
        }
      }

      const text = (finalSummary || streamedText).trim();
      if (code === 0 && text && !CODING_PLACEHOLDER.test(text)) {
        resolve(normalizePolishedRequirementText(text));
        return;
      }

      const detail = text || summarizeClaudeOutput(stdoutTail, stderr);
      reject(new Error(`需求整理失败: ${detail.slice(0, 500)}`));
    });

    child.stdin.write(userPrompt);
    child.stdin.end();
  });
}

/** 需求整理：独立调用 Claude Code（纯文字），与编码 Plan/执行无关，共用 CLAUDE_CLI_PATH */
export async function polishRequirementText(
  title: string,
  tapdUrl: string,
  rawContent: string,
  attachments: JobAttachment[] = [],
  options?: {
    sessionId?: string;
    onEvent?: AgentEventHandler;
  }
): Promise<string> {
  const userPrompt = buildRequirementAnalyzePrompt(title, tapdUrl, rawContent, attachments);

  console.log(`[AI Runtime] 需求整理（Claude Code 纯文字），目录: 临时目录，与 Git 无关`);

  return runRequirementClaude(userPrompt, attachments, options?.sessionId, options?.onEvent);
}

export function abortRequirementPolish(sessionId: string): boolean {
  return killAgentForJob(sessionId);
}
