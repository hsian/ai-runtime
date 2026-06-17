import type {
  AnalyzeEvent,
  AnalyzeRequirementRequest,
  AnalyzeSessionStatus,
  StartAnalyzeResponse,
  TapdRequirementFetchResult,
} from "./types.js";
import { normalizeServerUrl } from "./config.js";

interface SerializedImage {
  dataUrl: string;
  type?: string;
  name?: string;
}

function isBlob(value: unknown): value is Blob {
  return typeof Blob !== "undefined" && value instanceof Blob;
}

function isSerializedImage(value: unknown): value is SerializedImage {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as { dataUrl?: unknown }).dataUrl === "string"
  );
}

function dataUrlToBlob(dataUrl: string, typeHint?: string): Blob | null {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) return null;

  const mime = typeHint || match[1] || "application/octet-stream";
  const payload = match[3] ?? "";
  const binary = match[2] ? atob(payload) : decodeURIComponent(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

function normalizeImagePayloads(raw: unknown): Blob[] {
  if (!Array.isArray(raw)) return [];

  const blobs: Blob[] = [];
  for (const item of raw) {
    if (isBlob(item)) {
      blobs.push(item);
      continue;
    }
    if (isSerializedImage(item)) {
      const blob = dataUrlToBlob(item.dataUrl, item.type);
      if (blob) blobs.push(blob);
    }
  }
  return blobs;
}

export async function fetchTapdRequirement(): Promise<TapdRequirementFetchResult> {
  const response = await chrome.runtime.sendMessage({ type: "GET_TAPD_REQUIREMENT" });
  if (!response?.ok || !response.data) {
    throw new Error(response?.error ?? "无法读取 TAPD 需求");
  }

  return {
    requirement: response.data,
    imageBlobs: normalizeImagePayloads(response.imageBlobs),
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

export async function fetchAnalyzeEvents(
  serverUrl: string,
  sessionId: string
): Promise<AnalyzeEvent[]> {
  const res = await fetch(
    `${normalizeServerUrl(serverUrl)}/api/requirements/analyze/${encodeURIComponent(sessionId)}/events`
  );
  const data = (await res.json()) as { events?: AnalyzeEvent[]; error?: string };
  if (!res.ok) {
    throw new Error(data.error ?? `查询失败: ${res.status}`);
  }
  return Array.isArray(data.events) ? data.events : [];
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
