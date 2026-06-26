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

export async function fetchTapdIterationBugs(
  serverUrl: string,
  iterationId: string,
  prefix = TAPD_TASK_PREFIX
): Promise<{
  workspaceId: string;
  iterationId: string;
  bugs: TapdTaskItem[];
}> {
  const url = new URL(
    `${normalizeServerUrl(serverUrl)}/api/tapd/iterations/${encodeURIComponent(iterationId)}/bugs`
  );
  if (prefix) url.searchParams.set("prefix", prefix);

  const res = await fetch(url);
  const data = (await res.json()) as {
    workspaceId?: string;
    iterationId?: string;
    bugs?: TapdTaskItem[];
    error?: string;
  };
  if (!res.ok) {
    throw new Error(data.error ?? `获取缺陷失败: ${res.status}`);
  }
  return {
    workspaceId: data.workspaceId ?? "",
    iterationId: data.iterationId ?? iterationId,
    bugs: Array.isArray(data.bugs) ? data.bugs : [],
  };
}

export function htmlToPlainPromptText(html: string): string {
  let imageIndex = 0;
  const withoutImgs = html.replace(/<img\b[^>]*>/gi, () => {
    imageIndex += 1;
    return ` [配图${imageIndex}] `;
  });
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
    const imageCount = task.imageCount ?? (description.match(/<img\b/gi)?.length ?? 0);
    if (plain) {
      if (imageCount > 0 && !plain.includes("【配图说明")) {
        return `${plain}

【配图说明 — 必须遵守】
任务描述中的「如图N」「图N」「[配图N]」均指第 N 张配图，与随任务上传的附件「图N」路径一一对应（如图2 = 图2 = 配图2）。
Plan 阶段分析某段需求时，若文字提到「如图N」，必须先 Read 对应编号的附件图片，再写该段方案。
执行修改阶段优先按已确认方案实现；仅当方案未覆盖截图细节、或实现该段需求必须核对 UI 时，再 Read 对应编号的附件图片。
（描述中含 ${imageCount} 张配图，按 HTML 出现顺序编号为配图1…配图${imageCount}）`;
      }
      return plain;
    }
    return description;
  }
  return task.name?.trim() || "未命名任务";
}

export async function fetchTapdDescriptionImages(
  serverUrl: string,
  html: string,
  workspaceId?: string
): Promise<Blob[]> {
  const { prepareTapdJobImages } = await import("./tapdJobImages.js");
  const result = await prepareTapdJobImages(serverUrl, html, workspaceId);
  return result.images;
}
