import { getTapdConfig, type TapdConfig } from "../../config.js";

interface TapdApiEnvelope<T> {
  status: number;
  data: T;
  info: string;
}

interface TapdTokenData {
  access_token: string;
  expires_in: number;
  token_type: string;
}

export interface TapdStory {
  id: string;
  name: string;
  description?: string;
  status?: string;
  owner?: string;
  priority_label?: string;
  iteration_id?: string;
  parent_id?: string;
  children_id?: string;
}

export interface TapdTask {
  id: string;
  name: string;
  description?: string;
  status?: string;
  owner?: string;
  priority_label?: string;
  story_id?: string;
  iteration_id?: string;
}

export interface TapdBug {
  id: string;
  title?: string;
  name?: string;
  description?: string;
  status?: string;
  owner?: string;
  current_owner?: string;
  priority_label?: string;
  priority?: string;
  iteration_id?: string;
}

export interface TapdIteration {
  id: string;
  name: string;
  status?: string;
  startdate?: string;
  enddate?: string;
}

export interface TapdStoryWithTasks extends TapdStory {
  tasks: TapdTask[];
}

export interface TapdIterationWorkItems {
  workspaceId: string;
  iterationId: string;
  stories: TapdStoryWithTasks[];
  orphanTasks: TapdTask[];
}

let cachedToken: { value: string; expiresAt: number } | null = null;

function unwrapRecords<T>(data: unknown, key: string): T[] {
  if (!Array.isArray(data)) return [];
  const items: T[] = [];
  for (const row of data) {
    if (row && typeof row === "object" && key in row) {
      items.push((row as Record<string, T>)[key]);
    }
  }
  return items;
}

async function tapdRequest<T>(
  cfg: TapdConfig,
  path: string,
  params: Record<string, string | number | undefined> = {}
): Promise<TapdApiEnvelope<T>> {
  const token = await getAccessToken(cfg);
  const url = new URL(path, cfg.apiBase);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await res.json()) as TapdApiEnvelope<T>;
  if (!res.ok || body.status !== 1) {
    throw new Error(body.info || `TAPD API 请求失败: ${res.status}`);
  }
  return body;
}

async function fetchAllPages<T>(
  cfg: TapdConfig,
  path: string,
  params: Record<string, string | number | undefined>,
  recordKey: string
): Promise<T[]> {
  const pageSize = 200;
  const all: T[] = [];
  for (let page = 1; page <= 50; page += 1) {
    const body = await tapdRequest<unknown[]>(cfg, path, {
      ...params,
      limit: pageSize,
      page,
    });
    const batch = unwrapRecords<T>(body.data, recordKey);
    all.push(...batch);
    if (batch.length < pageSize) break;
  }
  return all;
}

export async function getAccessToken(cfg: TapdConfig = getTapdConfig()): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60_000) {
    return cachedToken.value;
  }

  const res = await fetch(new URL("/tokens/request_token", cfg.apiBase), {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  const body = (await res.json()) as TapdApiEnvelope<TapdTokenData>;
  if (!res.ok || body.status !== 1 || !body.data?.access_token) {
    throw new Error(body.info || "TAPD 换取 access_token 失败");
  }

  cachedToken = {
    value: body.data.access_token,
    expiresAt: now + body.data.expires_in * 1000,
  };
  return body.data.access_token;
}

export async function listIterations(
  workspaceId?: string,
  cfg: TapdConfig = getTapdConfig()
): Promise<TapdIteration[]> {
  const wsId = workspaceId ?? cfg.workspaceId;
  return fetchAllPages<TapdIteration>(cfg, "/iterations", { workspace_id: wsId }, "Iteration");
}

export async function listIterationTasks(
  iterationId: string,
  options?: { workspaceId?: string; prefix?: string },
  cfg: TapdConfig = getTapdConfig()
): Promise<TapdTask[]> {
  const wsId = options?.workspaceId ?? cfg.workspaceId;
  const tasks = await fetchAllPages<TapdTask>(
    cfg,
    "/tasks",
    { workspace_id: wsId, iteration_id: iterationId },
    "Task"
  );
  const prefix = options?.prefix?.trim();
  if (!prefix) return tasks;
  return tasks.filter((task) => (task.name ?? "").startsWith(prefix));
}

export async function listIterationBugs(
  iterationId: string,
  options?: { workspaceId?: string; prefix?: string },
  cfg: TapdConfig = getTapdConfig()
): Promise<TapdBug[]> {
  const wsId = options?.workspaceId ?? cfg.workspaceId;
  const bugs = await fetchAllPages<TapdBug>(
    cfg,
    "/bugs",
    { workspace_id: wsId, iteration_id: iterationId },
    "Bug"
  );
  const prefix = options?.prefix?.trim();
  if (!prefix) return bugs;
  return bugs.filter((bug) => (bug.title ?? bug.name ?? "").startsWith(prefix));
}

export async function getIterationWorkItems(
  iterationId: string,
  workspaceId?: string,
  cfg: TapdConfig = getTapdConfig()
): Promise<TapdIterationWorkItems> {
  const wsId = workspaceId ?? cfg.workspaceId;
  const [stories, tasks] = await Promise.all([
    fetchAllPages<TapdStory>(
      cfg,
      "/stories",
      { workspace_id: wsId, iteration_id: iterationId },
      "Story"
    ),
    fetchAllPages<TapdTask>(
      cfg,
      "/tasks",
      { workspace_id: wsId, iteration_id: iterationId },
      "Task"
    ),
  ]);

  const tasksByStory = new Map<string, TapdTask[]>();
  const orphanTasks: TapdTask[] = [];

  for (const task of tasks) {
    const storyId = task.story_id?.trim();
    if (!storyId || storyId === "0") {
      orphanTasks.push(task);
      continue;
    }
    const list = tasksByStory.get(storyId) ?? [];
    list.push(task);
    tasksByStory.set(storyId, list);
  }

  const storiesWithTasks: TapdStoryWithTasks[] = stories.map((story) => ({
    ...story,
    tasks: tasksByStory.get(story.id) ?? [],
  }));

  for (const [storyId, storyTasks] of tasksByStory) {
    if (!stories.some((story) => story.id === storyId)) {
      orphanTasks.push(...storyTasks);
    }
  }

  return {
    workspaceId: wsId,
    iterationId,
    stories: storiesWithTasks,
    orphanTasks,
  };
}

export async function getStory(
  storyId: string,
  workspaceId?: string,
  cfg: TapdConfig = getTapdConfig()
): Promise<TapdStory | null> {
  const wsId = workspaceId ?? cfg.workspaceId;
  const body = await tapdRequest<unknown[]>(cfg, "/stories", {
    workspace_id: wsId,
    id: storyId,
  });
  const stories = unwrapRecords<TapdStory>(body.data, "Story");
  return stories[0] ?? null;
}

export async function getTask(
  taskId: string,
  workspaceId?: string,
  cfg: TapdConfig = getTapdConfig()
): Promise<TapdTask | null> {
  const wsId = workspaceId ?? cfg.workspaceId;
  const body = await tapdRequest<unknown[]>(cfg, "/tasks", {
    workspace_id: wsId,
    id: taskId,
  });
  const tasks = unwrapRecords<TapdTask>(body.data, "Task");
  return tasks[0] ?? null;
}

interface TapdAttachmentDownload {
  download_url?: string;
  content_type?: string;
}

/** TAPD 富文本配图：用官方 API 换取临时下载链接（直接 fetch 图片地址会 403） */
export async function getTapdImageDownloadUrl(
  workspaceId: string,
  imagePath: string,
  cfg: TapdConfig = getTapdConfig()
): Promise<string | null> {
  const body = await tapdRequest<{ Attachment?: TapdAttachmentDownload }>(cfg, "/files/get_image", {
    workspace_id: workspaceId,
    image_path: imagePath,
  });
  return body.data?.Attachment?.download_url?.trim() || null;
}

/** TAPD 附件预览图：用附件 id 换取临时下载链接 */
export async function getTapdAttachmentDownloadUrl(
  workspaceId: string,
  attachmentId: string,
  cfg: TapdConfig = getTapdConfig()
): Promise<string | null> {
  const body = await tapdRequest<{ Attachment?: TapdAttachmentDownload }>(cfg, "/attachments/down", {
    workspace_id: workspaceId,
    id: attachmentId,
  });
  return body.data?.Attachment?.download_url?.trim() || null;
}

export function parseTapdUrl(url: string): {
  workspaceId?: string;
  iterationId?: string;
  storyId?: string;
  taskId?: string;
} {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const result: ReturnType<typeof parseTapdUrl> = {};

    const workspaceIndex = parts.findIndex((part) => /^\d+$/.test(part));
    if (workspaceIndex >= 0) {
      result.workspaceId = parts[workspaceIndex];
    }

    const iterationCardIndex = parts.indexOf("card");
    if (iterationCardIndex >= 0 && parts[iterationCardIndex - 1] === "iteration") {
      result.iterationId = parts[iterationCardIndex + 1];
    }

    const storiesIndex = parts.indexOf("stories");
    if (storiesIndex >= 0 && parts[storiesIndex + 1] === "view") {
      result.storyId = parts[storiesIndex + 2];
    }

    const tasksIndex = parts.indexOf("tasks");
    if (tasksIndex >= 0 && parts[tasksIndex + 1] === "view") {
      result.taskId = parts[tasksIndex + 2];
    }

    return result;
  } catch {
    return {};
  }
}
