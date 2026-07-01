import type { JobStatus, PageContext, SubmitRequest, SubmitResponse } from "./types.js";
import { normalizeServerUrl } from "./config.js";
import {
  clearPendingServerCancel,
  getPendingServerCancelJobId,
} from "./codingJobStore.js";

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

export async function replyToPlan(
  serverUrl: string,
  jobId: string,
  reply: string
): Promise<SubmitResponse> {
  const res = await fetch(
    `${normalizeServerUrl(serverUrl)}/api/jobs/${encodeURIComponent(jobId)}/plan-reply`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reply }),
    }
  );
  const data = (await res.json()) as SubmitResponse & { error?: string };
  if (!res.ok) {
    throw new Error(data.error ?? `请求失败: ${res.status}`);
  }
  return data;
}

export async function executeJob(
  serverUrl: string,
  jobId: string,
  planSummary?: string
): Promise<SubmitResponse> {
  const res = await fetch(`${normalizeServerUrl(serverUrl)}/api/jobs/${encodeURIComponent(jobId)}/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(planSummary ? { planSummary } : {}),
  });
  const data = (await res.json()) as SubmitResponse & { error?: string };
  if (!res.ok) {
    throw new Error(data.error ?? `请求失败: ${res.status}`);
  }
  return data;
}

export async function discardMerge(serverUrl: string, jobId: string): Promise<{ ok: boolean }> {
  const res = await fetch(
    `${normalizeServerUrl(serverUrl)}/api/jobs/${encodeURIComponent(jobId)}/discard-merge`,
    { method: "POST" }
  );
  const data = (await res.json()) as { ok?: boolean; error?: string };
  if (!res.ok) {
    throw new Error(data.error ?? `请求失败: ${res.status}`);
  }
  return { ok: Boolean(data.ok) };
}

export async function mergeJob(
  serverUrl: string,
  jobId: string,
  options?: { createMergeRequest?: boolean }
): Promise<SubmitResponse> {
  const res = await fetch(`${normalizeServerUrl(serverUrl)}/api/jobs/${encodeURIComponent(jobId)}/merge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options?.createMergeRequest ? { createMergeRequest: true } : {}),
  });
  const data = (await res.json()) as SubmitResponse & { error?: string };
  if (!res.ok) {
    throw new Error(data.error ?? `请求失败: ${res.status}`);
  }
  return data;
}

export async function listJobs(serverUrl: string): Promise<JobStatus[]> {
  const res = await fetch(`${normalizeServerUrl(serverUrl)}/api/jobs`);
  const data = (await res.json()) as { jobs?: JobStatus[]; error?: string };
  if (!res.ok) {
    throw new Error(data.error ?? `查询失败: ${res.status}`);
  }
  return Array.isArray(data.jobs) ? data.jobs : [];
}

export async function fetchReleaseBranches(serverUrl: string, jobId: string): Promise<string[]> {
  const res = await fetch(
    `${normalizeServerUrl(serverUrl)}/api/jobs/${encodeURIComponent(jobId)}/release-branches`
  );
  const data = (await res.json()) as { branches?: string[]; error?: string };
  if (!res.ok) {
    throw new Error(data.error ?? `查询分支失败: ${res.status}`);
  }
  return Array.isArray(data.branches) ? data.branches : [];
}

export async function mergeJobToReleaseBranch(
  serverUrl: string,
  jobId: string,
  targetBranch: string
): Promise<JobStatus> {
  const res = await fetch(
    `${normalizeServerUrl(serverUrl)}/api/jobs/${encodeURIComponent(jobId)}/release-merge`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetBranch }),
    }
  );
  const data = (await res.json()) as { ok?: boolean; job?: JobStatus; error?: string };
  if (!res.ok || !data.job) {
    throw new Error(data.error ?? `合并失败: ${res.status}`);
  }
  return data.job;
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

function isCancelSettledError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /不存在|404|not found|当前状态不可取消/i.test(msg);
}

/** 补发断网时未送达的取消请求；返回 true 表示无需再重试 */
export async function flushPendingServerCancel(serverUrl: string): Promise<boolean> {
  const jobId = await getPendingServerCancelJobId();
  if (!jobId) return true;

  try {
    await cancelJob(serverUrl, jobId);
    await clearPendingServerCancel();
    return true;
  } catch (err) {
    if (isCancelSettledError(err)) {
      await clearPendingServerCancel();
      return true;
    }
    return false;
  }
}

export async function queryJobStatus(serverUrl: string, jobId: string): Promise<JobStatus> {
  const res = await fetch(`${normalizeServerUrl(serverUrl)}/api/jobs/${jobId}`);
  const data = (await res.json()) as JobStatus & { error?: string };

  if (!res.ok) {
    throw new Error(data.error ?? `查询失败: ${res.status}`);
  }
  return data;
}

export async function fetchJobEvents(
  serverUrl: string,
  jobId: string
): Promise<import("./types.js").JobEvent[]> {
  const res = await fetch(
    `${normalizeServerUrl(serverUrl)}/api/jobs/${encodeURIComponent(jobId)}/events`
  );
  const data = (await res.json()) as { events?: import("./types.js").JobEvent[]; error?: string };
  if (!res.ok) {
    throw new Error(data.error ?? `查询失败: ${res.status}`);
  }
  return Array.isArray(data.events) ? data.events : [];
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function queryJobStatusWithRetry(
  serverUrl: string,
  jobId: string,
  attempts = 5
): Promise<JobStatus> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await queryJobStatus(serverUrl, jobId);
    } catch (err) {
      lastError = err;
      if (!isNotFoundError(err) || i === attempts - 1) {
        throw err;
      }
      await sleep(600 * (i + 1));
    }
  }
  throw lastError;
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

  if (/当前状态不可|任务不存在|分析任务不存在|参数无效|不可执行|不可取消|不可合并|不可放弃合并|放弃合并/.test(msg)) {
    return msg;
  }

  if (/Failed to fetch|NetworkError|fetch failed|网络错误/i.test(msg)) {
    return getNetworkErrorHint(serverUrl, err);
  }

  return msg;
}

export function isNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /不存在|404|not found/i.test(msg);
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
