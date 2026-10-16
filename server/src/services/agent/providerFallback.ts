import { AgentAbortedError } from "./errors.js";
import type { AgentEventHandler, AgentResult, AgentRunOptions } from "./types.js";
import type { PageContext } from "../../types.js";

export class CodexQuotaError extends Error {
  constructor(message: string) { super(message); this.name = "CodexQuotaError"; }
}

// A generic 429 may be transient throttling or an API called by a tool.
// Only an explicit Codex account quota error may switch providers.
export function isCodexQuotaMessage(message: string): boolean {
  return /\b(?:usage_limit_reached|insufficient_quota|quota_exceeded)\b|\b(?:you(?:'ve| have) (?:hit|reached) your usage limit|usage limit (?:has been )?(?:reached|exceeded)|(?:credits?|quota) (?:exhausted|depleted)|(?:exceeded|exhausted) (?:your |the )?(?:current )?quota|not enough credits|credit balance is too low)\b|(?:额度|配额)(?:已)?(?:耗尽|用完|不足)/i.test(message);
}

type Runner = (repoPath: string, prompt: string, pageContext?: PageContext, onEvent?: AgentEventHandler, options?: AgentRunOptions) => Promise<AgentResult>;

export function createAutomaticAgent(codex: Runner, claude: Runner): Runner {
  return async (repoPath, prompt, pageContext, onEvent, options) => {
    try {
      return await codex(repoPath, prompt, pageContext, onEvent, { ...options, agentProvider: "codex" });
    } catch (error) {
      if (error instanceof AgentAbortedError || !(error instanceof CodexQuotaError)) throw error;
      onEvent?.({ type: "agent_status", agentProvider: "claude", statusText: "Codex 额度已用完，正在切换到 Claude 继续处理…" });
      const continuation = options?.disableTools ? "" : "\n\n【自动接续】Codex 因额度耗尽中断。本轮沿用同一工作目录、任务和对话。先检查当前工作区及已有改动，再完成剩余工作；保留此前正确修改，不要重复已经完成的操作。不得自行切换分支或执行合并、推送。";
      return claude(repoPath, prompt + continuation, pageContext, onEvent, { ...options, agentProvider: "claude" });
    }
  };
}
