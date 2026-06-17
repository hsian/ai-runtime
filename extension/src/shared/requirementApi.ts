import type { TapdRequirement, AnalyzeRequirementRequest, AnalyzeRequirementResponse } from "./types.js";
import { normalizeServerUrl } from "./config.js";

export async function fetchTapdRequirement(): Promise<TapdRequirement> {
  const response = await chrome.runtime.sendMessage({ type: "GET_TAPD_REQUIREMENT" });
  if (!response?.ok) {
    throw new Error(response?.error ?? "无法读取 TAPD 需求");
  }
  return response.data as TapdRequirement;
}

export async function analyzeRequirement(
  serverUrl: string,
  body: AnalyzeRequirementRequest
): Promise<AnalyzeRequirementResponse> {
  const res = await fetch(`${normalizeServerUrl(serverUrl)}/api/requirements/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = (await res.json()) as AnalyzeRequirementResponse & { error?: string };
  if (!res.ok) {
    throw new Error(data.error ?? `分析失败: ${res.status}`);
  }
  return data;
}
