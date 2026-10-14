import { config } from "../../config.js";
import { prepareAgentApiDocs } from "../agentApiDocs.js";
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
  let documents: Awaited<ReturnType<typeof prepareAgentApiDocs>> | undefined;
  if (options?.apiDocAccess && !options.disableTools) {
    onEvent?.({ type: "agent_status", statusText: "正在读取最新接口文档…" });
    try { documents = await prepareAgentApiDocs(); prompt += documents.context; }
    catch {
      prompt += "\n【接口文档】本轮内置文档读取失败。可查项目代码，但不能声称文档没有字段；若阻塞，明确说明缺少哪一个接口的字段定义。";
      onEvent?.({ type: "agent_status", statusText: "接口文档暂时无法读取，将结合代码继续分析" });
    }
  }
  try {
    return provider === "codex" ? await runCodexAgent(repoPath, prompt, pageContext, onEvent, options)
      : await runClaudeAgent(repoPath, prompt, pageContext, onEvent, options);
  } finally { await documents?.dispose(); }
}
