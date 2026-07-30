import { normalizeServerUrl } from "./config.js";
import { prepareTapdJobImages } from "./tapdJobImages.js";
import type {
  TapdContext,
  TapdItemType,
  TapdIteration,
  TapdTaskItem,
  TapdWorkspace,
} from "./types.js";

export const TAPD_TASK_PREFIX = "AI";

function parseTapdItemUrl(
  value: string
): { workspaceId: string; itemType: TapdItemType; itemId: string } | null {
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase();
    if (
      hostname !== "tapd.cn" &&
      hostname !== "tapd.com" &&
      !hostname.endsWith(".tapd.cn") &&
      !hostname.endsWith(".tapd.com")
    ) {
      return null;
    }

    const parts = parsed.pathname.split("/").filter(Boolean);
    const workspaceId = parts.find((part) => /^\d+$/.test(part));
    let itemType: TapdItemType | undefined;
    let itemId: string | undefined;

    const storiesIndex = parts.indexOf("stories");
    if (storiesIndex >= 0 && parts[storiesIndex + 1] === "view") {
      itemType = "story";
      itemId = parts[storiesIndex + 2];
    }
    const tasksIndex = parts.indexOf("tasks");
    if (tasksIndex >= 0 && parts[tasksIndex + 1] === "view") {
      itemType = "task";
      itemId = parts[tasksIndex + 2];
    }
    const bugsIndex = parts.findIndex((part) => part === "bugs" || part === "bug");
    if (
      bugsIndex >= 0 &&
      (parts[bugsIndex + 1] === "view" || parts[bugsIndex + 1] === "detail")
    ) {
      itemType = "bug";
      itemId = parts[bugsIndex + 2];
    }

    const previewMatch = parsed.searchParams
      .get("dialog_preview_id")
      ?.match(/^(story|task|bug)_(\d+)$/);
    if (previewMatch) {
      itemType = previewMatch[1] as TapdItemType;
      itemId = previewMatch[2];
    }
    return workspaceId && itemType && itemId ? { workspaceId, itemType, itemId } : null;
  } catch {
    return null;
  }
}

async function readJsonResponse<T>(
  response: Response
): Promise<{ data?: T; error?: string; isJson: boolean }> {
  const text = await response.text();
  if (!text.trim()) return { isJson: false };
  try {
    return { data: JSON.parse(text) as T, isJson: true };
  } catch {
    return {
      isJson: false,
      error: text.trimStart().startsWith("<!DOCTYPE")
        ? "服务端返回了网页而不是接口数据"
        : "服务端返回的内容不是有效 JSON",
    };
  }
}

export async function resolveTapdContext(serverUrl: string, url: string): Promise<TapdContext> {
  const res = await fetch(`${normalizeServerUrl(serverUrl)}/api/tapd/context/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  const aggregate = await readJsonResponse<{ context?: TapdContext; error?: string }>(res);
  if (res.ok && aggregate.data?.context) {
    return { ...aggregate.data.context, transportMode: "structured" };
  }

  const shouldUseLegacyFallback =
    !aggregate.isJson || res.status === 400 || res.status === 404 || res.status === 405;
  if (!shouldUseLegacyFallback) {
    throw new Error(aggregate.data?.error ?? aggregate.error ?? `获取 TAPD 需求失败: ${res.status}`);
  }

  const parsed = parseTapdItemUrl(url);
  if (!parsed) {
    throw new Error("无法从链接中识别 TAPD 项目、条目类型和 ID");
  }
  const resource = parsed.itemType === "story" ? "stories" : parsed.itemType === "task" ? "tasks" : "bugs";
  const itemUrl = new URL(
    `${normalizeServerUrl(serverUrl)}/api/tapd/${resource}/${encodeURIComponent(parsed.itemId)}`
  );
  itemUrl.searchParams.set("workspaceId", parsed.workspaceId);
  const itemResponse = await fetch(itemUrl);
  const legacy = await readJsonResponse<{
    story?: TapdTaskItem;
    task?: TapdTaskItem;
    bug?: TapdTaskItem & { title?: string; current_owner?: string };
    error?: string;
  }>(itemResponse);
  const item = legacy.data?.story ?? legacy.data?.task ?? legacy.data?.bug;
  if (!itemResponse.ok || !item) {
    if (!legacy.isJson) {
      throw new Error("服务端未提供对应的 TAPD 条目读取接口，请更新并重启 ai-runtime server");
    }
    throw new Error(legacy.data?.error ?? `获取 TAPD 条目失败: ${itemResponse.status}`);
  }

  const title = "title" in item ? item.title ?? item.name : item.name;
  const owner = "current_owner" in item ? item.current_owner ?? item.owner : item.owner;
  return {
    workspaceId: parsed.workspaceId,
    itemType: parsed.itemType,
    itemId: item.id,
    storyId: parsed.itemType === "story" ? item.id : undefined,
    url,
    title: title || `${parsed.itemType} ${item.id}`,
    description: htmlToPlainPromptText(item.description ?? ""),
    sourceHtml: item.description ?? "",
    imageCount: item.description?.match(/<img\b/gi)?.length ?? 0,
    status: item.status,
    owner,
    fetchedAt: new Date().toISOString(),
    transportMode: "legacy",
  };
}

export async function fetchTapdWorkspaces(serverUrl: string): Promise<{
  defaultWorkspaceId: string;
  workspaces: TapdWorkspace[];
  warning?: string;
}> {
  const res = await fetch(`${normalizeServerUrl(serverUrl)}/api/tapd/workspaces`);
  const data = (await res.json()) as {
    defaultWorkspaceId?: string;
    workspaces?: TapdWorkspace[];
    warning?: string;
    error?: string;
  };
  if (!res.ok) {
    throw new Error(data.error ?? `获取 TAPD 项目失败: ${res.status}`);
  }
  return {
    defaultWorkspaceId: data.defaultWorkspaceId ?? "",
    workspaces: Array.isArray(data.workspaces) ? data.workspaces : [],
    warning: data.warning,
  };
}

export async function fetchTapdIterations(serverUrl: string, workspaceId?: string): Promise<{
  workspaceId: string;
  iterations: TapdIteration[];
}> {
  const url = new URL(`${normalizeServerUrl(serverUrl)}/api/tapd/iterations`);
  if (workspaceId) url.searchParams.set("workspaceId", workspaceId);
  const res = await fetch(url);
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
  prefix = TAPD_TASK_PREFIX,
  workspaceId?: string
): Promise<{
  workspaceId: string;
  iterationId: string;
  tasks: TapdTaskItem[];
}> {
  const url = new URL(
    `${normalizeServerUrl(serverUrl)}/api/tapd/iterations/${encodeURIComponent(iterationId)}/tasks`
  );
  if (prefix) url.searchParams.set("prefix", prefix);
  if (workspaceId) url.searchParams.set("workspaceId", workspaceId);

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
  prefix = TAPD_TASK_PREFIX,
  workspaceId?: string
): Promise<{
  workspaceId: string;
  iterationId: string;
  bugs: TapdTaskItem[];
}> {
  const url = new URL(
    `${normalizeServerUrl(serverUrl)}/api/tapd/iterations/${encodeURIComponent(iterationId)}/bugs`
  );
  if (prefix) url.searchParams.set("prefix", prefix);
  if (workspaceId) url.searchParams.set("workspaceId", workspaceId);

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

export async function createTapdBug(
  serverUrl: string,
  input: {
    title: string;
    description: string;
    iterationId: string;
    workspaceId?: string;
  }
): Promise<{ workspaceId: string; iterationId: string; bug: TapdTaskItem }> {
  const res = await fetch(`${normalizeServerUrl(serverUrl)}/api/tapd/bugs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = (await res.json()) as {
    workspaceId?: string;
    iterationId?: string;
    bug?: TapdTaskItem;
    error?: string;
  };
  if (!res.ok || !data.bug) {
    throw new Error(data.error ?? `创建缺陷失败: ${res.status}`);
  }
  return {
    workspaceId: data.workspaceId ?? input.workspaceId ?? "",
    iterationId: data.iterationId ?? input.iterationId,
    bug: data.bug,
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
  const result = await prepareTapdJobImages(serverUrl, html, workspaceId);
  return result.images;
}
