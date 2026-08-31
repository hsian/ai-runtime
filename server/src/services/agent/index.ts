import { config } from "../../config.js";
import { runClaudeAgent } from "./claudeAgentService.js";
import { runCodexAgent } from "./codexAgentService.js";
import type { AgentEventHandler, AgentProvider, AgentResult, AgentRunOptions } from "./types.js";
import type { PageContext } from "../../types.js";

export type { AgentResult, AgentEventHandler, AgentProvider } from "./types.js";
export { killAgentForJob } from "./agentProcessRegistry.js";
export { AgentAbortedError } from "./errors.js";

export async function runAgent(
  repoPath: string,
  prompt: string,
  pageContext?: PageContext,
  onEvent?: AgentEventHandler,
  options?: AgentRunOptions
): Promise<AgentResult> {
  const provider: AgentProvider = options?.agentProvider ?? config.AGENT_PROVIDER;
  if (provider === "codex") {
    return runCodexAgent(repoPath, prompt, pageContext, onEvent, options);
  }
  return runClaudeAgent(repoPath, prompt, pageContext, onEvent, options);
}
