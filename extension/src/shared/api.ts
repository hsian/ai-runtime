import type { JobStatus, PageContext, SubmitRequest, SubmitResponse } from "./types.js";
import { normalizeServerUrl } from "./config.js";

export async function fetchPageContext(includeContext: boolean): Promise<PageContext | undefined> {
  if (!includeContext) return undefined;

  const response = await chrome.runtime.sendMessage({ type: "GET_PAGE_CONTEXT" });
  if (!response?.ok) {
    throw new Error(response?.error ?? "无法获取当前页面信息");
  }
  return response.data as PageContext;
}

export async function fetchCurrentTabPreview(): Promise<PageContext | null> {
  const response = await chrome.runtime.sendMessage({ type: "GET_TAB_PREVIEW" });
  if (!response?.ok) return null;
  return response.data as PageContext;
}

async function postJob(
  serverUrl: string,
  path: string,
  body: SubmitRequest
): Promise<SubmitResponse> {
  const hasImages = Boolean(body.images?.length);

  const res = hasImages
    ? await fetch(`${normalizeServerUrl(serverUrl)}${path}`, {
        method: "POST",
        body: buildSubmitFormData(body),
      })
    : await fetch(`${normalizeServerUrl(serverUrl)}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: body.prompt,
          pageContext: body.pageContext,
          submittedBy: body.submittedBy,
        }),
      });

  const data = (await res.json()) as SubmitResponse & { error?: string };
  if (!res.ok) {
    throw new Error(data.error ?? `请求失败: ${res.status}`);
  }
  return data;
}

function buildSubmitFormData(body: SubmitRequest): FormData {
  const form = new FormData();
  form.append("prompt", body.prompt);
  if (body.pageContext) {
    form.append("pageContext", JSON.stringify(body.pageContext));
  }
  if (body.submittedBy) {
    form.append("submittedBy", body.submittedBy);
  }
  for (const [index, image] of (body.images ?? []).entries()) {
    form.append("images", image, `screenshot-${index + 1}.webp`);
  }
  return form;
}

export async function submitJob(
  serverUrl: string,
  body: SubmitRequest
): Promise<SubmitResponse> {
  return postJob(serverUrl, "/api/jobs", body);
}

export async function submitPlan(
  serverUrl: string,
  body: SubmitRequest
): Promise<SubmitResponse> {
  return postJob(serverUrl, "/api/jobs/plan", body);
}

export async function executeJob(serverUrl: string, jobId: string): Promise<SubmitResponse> {
  const res = await fetch(`${normalizeServerUrl(serverUrl)}/api/jobs/${encodeURIComponent(jobId)}/execute`, {
    method: "POST",
  });
  const data = (await res.json()) as SubmitResponse & { error?: string };
  if (!res.ok) {
    throw new Error(data.error ?? `请求失败: ${res.status}`);
  }
  return data;
}

export async function cancelJob(serverUrl: string, jobId: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${normalizeServerUrl(serverUrl)}/api/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: "POST",
  });
  const data = (await res.json()) as { ok?: boolean; error?: string };
  if (!res.ok) {
    throw new Error(data.error ?? `请求失败: ${res.status}`);
  }
  return { ok: Boolean(data.ok) };
}

export async function queryJobStatus(serverUrl: string, jobId: string): Promise<JobStatus> {
  const res = await fetch(`${normalizeServerUrl(serverUrl)}/api/jobs/${jobId}`);
  const data = (await res.json()) as JobStatus & { error?: string };

  if (!res.ok) {
    throw new Error(data.error ?? `查询失败: ${res.status}`);
  }
  return data;
}

export function getNetworkErrorHint(serverUrl: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const hint = /6000|6667|6666/.test(serverUrl)
    ? "\n\n提示：Chrome 禁止访问 6000 等端口，请改用 6080、8080 等端口"
    : "";
  return `网络错误: ${msg}${hint}`;
}

/** 区分 API 业务错误与真实网络错误 */
export function formatErrorMessage(serverUrl: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);

  if (/当前状态不可|任务不存在|参数无效|不可执行|不可取消/.test(msg)) {
    return msg;
  }

  if (/Failed to fetch|NetworkError|fetch failed|网络错误/i.test(msg)) {
    return getNetworkErrorHint(serverUrl, err);
  }

  return msg;
}

export function openJobEventStream(
  serverUrl: string,
  jobId: string,
  onEvent: (event: import("./types.js").JobEvent) => void,
  handlers?: {
    onOpen?: () => void;
    onError?: (err: Event) => void;
    onClose?: () => void;
  }
): EventSource {
  const es = new EventSource(`${normalizeServerUrl(serverUrl)}/api/jobs/${encodeURIComponent(jobId)}/stream`);
  es.onmessage = (message) => {
    try {
      onEvent(JSON.parse(message.data) as import("./types.js").JobEvent);
    } catch {
      // ignore malformed payloads
    }
  };

  es.onopen = () => handlers?.onOpen?.();
  es.onerror = (err) => handlers?.onError?.(err);

  // 服务端会发送 `event: close`
  es.addEventListener("close", () => {
    handlers?.onClose?.();
    es.close();
  });

  return es;
}
