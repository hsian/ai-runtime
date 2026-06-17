import { resolve } from "path";
import { runClaudeAgent } from "./agent/claudeAgentService.js";
import {
  buildRequirementAnalyzePrompt,
  REQUIREMENT_ANALYZE_SYSTEM_PROMPT,
} from "./agent/types.js";
import type { JobAttachment } from "../types.js";

export async function analyzeRequirement(
  title: string,
  tapdUrl: string,
  rawContent: string,
  attachments: JobAttachment[] = []
): Promise<string> {
  const userPrompt = buildRequirementAnalyzePrompt(title, tapdUrl, rawContent, attachments);

  const result = await runClaudeAgent(resolve(process.cwd()), userPrompt, undefined, undefined, {
    mode: "requirement",
    systemPrompt: REQUIREMENT_ANALYZE_SYSTEM_PROMPT,
    permissionMode: "plan",
    attachments: attachments.length > 0 ? attachments : undefined,
  });

  return result.summary.trim();
}
