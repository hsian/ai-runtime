import type { AgentEventHandler } from "./agent/types.js";
import type { JobAttachment } from "../types.js";
import { polishRequirementText } from "./requirementTextPolisher.js";

/** 需求整理入口（Claude Code 纯文字，与编码 Plan/执行 独立调用） */
export async function analyzeRequirement(
  title: string,
  tapdUrl: string,
  rawContent: string,
  attachments: JobAttachment[] = [],
  options?: {
    sessionId?: string;
    onEvent?: AgentEventHandler;
  }
): Promise<string> {
  return polishRequirementText(title, tapdUrl, rawContent, attachments, options);
}
