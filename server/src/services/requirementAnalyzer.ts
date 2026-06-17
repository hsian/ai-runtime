import { resolve } from "path";
import { runClaudeAgent } from "./agent/claudeAgentService.js";
import {
  buildRequirementAnalyzePrompt,
  REQUIREMENT_ANALYZE_SYSTEM_PROMPT,
} from "./agent/types.js";

export async function analyzeRequirement(
  title: string,
  tapdUrl: string,
  rawContent: string
): Promise<string> {
  const userPrompt = buildRequirementAnalyzePrompt(title, tapdUrl, rawContent);

  const result = await runClaudeAgent(resolve(process.cwd()), userPrompt, undefined, undefined, {
    mode: "requirement",
    systemPrompt: REQUIREMENT_ANALYZE_SYSTEM_PROMPT,
    permissionMode: "plan",
  });

  return result.summary.trim();
}
