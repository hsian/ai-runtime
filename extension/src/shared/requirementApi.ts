import type {
  AnalyzeEvent,
  AnalyzeRequirementRequest,
  AnalyzeSessionStatus,
  StartAnalyzeResponse,
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

export async function startAnalyzeRequirement(
  serverUrl: string,
  body: AnalyzeRequirementRequest
): Promise<StartAnalyzeResponse> {
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

  const data = (await res.json()) as StartAnalyzeResponse & { error?: string };
  if (!res.ok) {
    throw new Error(data.error ?? `分析失败: ${res.status}`);
  }
  return data;
}

export async function cancelAnalyzeRequirement(
  serverUrl: string,
  sessionId: string
): Promise<{ ok: boolean }> {
  const res = await fetch(
    `${normalizeServerUrl(serverUrl)}/api/requirements/analyze/${encodeURIComponent(sessionId)}/cancel`,
    { method: "POST" }
  );
  const data = (await res.json()) as { ok?: boolean; error?: string };
  if (!res.ok) {
    throw new Error(data.error ?? `取消失败: ${res.status}`);
  }
  return { ok: Boolean(data.ok) };
}

export async function fetchAnalyzeSession(
  serverUrl: string,
  sessionId: string
): Promise<AnalyzeSessionStatus> {
  const res = await fetch(
    `${normalizeServerUrl(serverUrl)}/api/requirements/analyze/${encodeURIComponent(sessionId)}`
  );
  const data = (await res.json()) as AnalyzeSessionStatus & { error?: string };
  if (!res.ok) {
    throw new Error(data.error ?? `查询失败: ${res.status}`);
  }
  return data;
}

export function openAnalyzeEventStream(
  serverUrl: string,
  sessionId: string,
  onEvent: (event: AnalyzeEvent) => void,
  handlers?: {
    onOpen?: () => void;
    onError?: (err: Event) => void;
    onClose?: () => void;
  }
): EventSource {
  const es = new EventSource(
    `${normalizeServerUrl(serverUrl)}/api/requirements/analyze/${encodeURIComponent(sessionId)}/stream`
  );
  es.onmessage = (message) => {
    try {
      onEvent(JSON.parse(message.data) as AnalyzeEvent);
    } catch {
      // ignore malformed payloads
    }
  };

  es.onopen = () => handlers?.onOpen?.();
  es.onerror = (err) => handlers?.onError?.(err);

  es.addEventListener("close", () => {
    handlers?.onClose?.();
    es.close();
  });

  return es;
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
