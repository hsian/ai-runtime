import { normalizeServerUrl } from "./config.js";
import type { TapdIteration, TapdTaskItem } from "./types.js";

export const TAPD_TASK_PREFIX = "AI";

export async function fetchTapdIterations(serverUrl: string): Promise<{
  workspaceId: string;
  iterations: TapdIteration[];
}> {
  const res = await fetch(`${normalizeServerUrl(serverUrl)}/api/tapd/iterations`);
  const data = (await res.json()) as {
    workspaceId?: string;
    iterations?: TapdIteration[];
    error?: string;
  };
  if (!res.ok) {
    throw new Error(data.error ?? `获取迭代失败: ${res.status}`);
  }
  return {
    workspaceId: data.workspaceId ?? "",
    iterations: Array.isArray(data.iterations) ? data.iterations : [],
  };
}

export async function fetchTapdIterationTasks(
  serverUrl: string,
  iterationId: string,
  prefix = TAPD_TASK_PREFIX
): Promise<{
  workspaceId: string;
  iterationId: string;
  tasks: TapdTaskItem[];
}> {
  const url = new URL(
    `${normalizeServerUrl(serverUrl)}/api/tapd/iterations/${encodeURIComponent(iterationId)}/tasks`
  );
  if (prefix) url.searchParams.set("prefix", prefix);

  const res = await fetch(url);
  const data = (await res.json()) as {
    workspaceId?: string;
    iterationId?: string;
    tasks?: TapdTaskItem[];
    error?: string;
  };
  if (!res.ok) {
    throw new Error(data.error ?? `获取任务失败: ${res.status}`);
  }
  return {
    workspaceId: data.workspaceId ?? "",
    iterationId: data.iterationId ?? iterationId,
    tasks: Array.isArray(data.tasks) ? data.tasks : [],
  };
}

export function htmlToPlainPromptText(html: string): string {
  const withoutImgs = html.replace(/<img\b[^>]*>/gi, " [配图] ");
  const text = withoutImgs
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\s{2,}/g, " ")
    .trim();
  return text;
}

export function buildTaskPrompt(task: TapdTaskItem, editedPrompt?: string): string {
  const custom = editedPrompt?.trim();
  if (custom) return custom;
  const description = task.description?.trim();
  if (description) {
    const plain = htmlToPlainPromptText(description);
    if (plain) return plain;
    return description;
  }
  return task.name?.trim() || "未命名任务";
}

interface SerializedTapdImage {
  dataUrl: string;
  mime?: string;
  name?: string;
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

export async function fetchTapdDescriptionImages(
  serverUrl: string,
  html: string
): Promise<Blob[]> {
  if (!html.trim() || !/<img\b/i.test(html)) return [];

  const res = await fetch(`${normalizeServerUrl(serverUrl)}/api/tapd/images/from-html`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ html }),
  });
  const data = (await res.json()) as {
    images?: SerializedTapdImage[];
    error?: string;
  };
  if (!res.ok) {
    throw new Error(data.error ?? `下载配图失败: ${res.status}`);
  }

  const blobs: Blob[] = [];
  for (const item of data.images ?? []) {
    const blob = dataUrlToBlob(item.dataUrl, item.mime);
    if (blob) blobs.push(blob);
  }
  return blobs;
}
