import type {
  AnalyzeRequirementRequest,
  AnalyzeRequirementResponse,
  TapdRequirementFetchResult,
} from "./types.js";
import { normalizeServerUrl } from "./config.js";

export async function fetchTapdRequirement(): Promise<TapdRequirementFetchResult> {
  const response = await chrome.runtime.sendMessage({ type: "GET_TAPD_REQUIREMENT" });
  if (!response?.ok || !response.data) {
    throw new Error(response?.error ?? "无法读取 TAPD 需求");
  }

  return {
    requirement: response.data,
    imageBlobs: Array.isArray(response.imageBlobs) ? response.imageBlobs : [],
  };
}

export async function analyzeRequirement(
  serverUrl: string,
  body: AnalyzeRequirementRequest
): Promise<AnalyzeRequirementResponse> {
  const hasImages = Boolean(body.images?.length);

  const res = hasImages
    ? await fetch(`${normalizeServerUrl(serverUrl)}/api/requirements/analyze`, {
        method: "POST",
        body: buildAnalyzeFormData(body),
      })
    : await fetch(`${normalizeServerUrl(serverUrl)}/api/requirements/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: body.title,
          tapdUrl: body.tapdUrl,
          rawContent: body.rawContent,
        }),
      });

  const data = (await res.json()) as AnalyzeRequirementResponse & { error?: string };
  if (!res.ok) {
    throw new Error(data.error ?? `分析失败: ${res.status}`);
  }
  return data;
}

function buildAnalyzeFormData(body: AnalyzeRequirementRequest): FormData {
  const form = new FormData();
  form.append("title", body.title);
  form.append("tapdUrl", body.tapdUrl);
  form.append("rawContent", body.rawContent);
  for (const [index, image] of (body.images ?? []).entries()) {
    form.append("images", image, `tapd-${index + 1}.webp`);
  }
  return form;
}
