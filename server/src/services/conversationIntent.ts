import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "./agent/index.js";
import type { AgentEventHandler } from "./agent/types.js";
import { parseRoutingResult, routingAgentOptions } from "./conversationRouting.js";

export type IntentModel = (input: string) => Promise<string>;

export async function classifyWithAgent(input: string, context?: { jobId?: string; onEvent?: AgentEventHandler }): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ai-runtime-conversation-intent-"));
  try {
    const result = await runAgent(directory, input, undefined, context?.onEvent, { ...routingAgentOptions(), jobId: context?.jobId });
    return result.summary;
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
      .catch(() => console.warn("[Conversation] 临时会话目录暂时被占用，未影响识别结果"));
  }
}

export async function routeConversation(payload: object, model: IntentModel = classifyWithAgent) {
  const raw = await model(JSON.stringify(payload));
  try { return parseRoutingResult(raw); }
  catch {
    // Repair malformed output once; transport failures must not trigger code analysis.
    return parseRoutingResult(await model(JSON.stringify({ ...payload, outputRepair: true })));
  }
}
