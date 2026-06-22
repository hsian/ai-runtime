import type { CodingTask } from "./types.js";

const TASKS_KEY = "codingTasks";
const LEGACY_TASKS_KEY = "requirementTasks";

function normalizeTask(raw: unknown): CodingTask | null {
  if (!raw || typeof raw !== "object") return null;
  const task = raw as Record<string, unknown>;
  if (typeof task.id !== "string") return null;
  return {
    id: task.id,
    title: typeof task.title === "string" ? task.title : "",
    pageUrl:
      typeof task.pageUrl === "string"
        ? task.pageUrl
        : typeof task.tapdUrl === "string"
          ? task.tapdUrl
          : "",
    rawContent: typeof task.rawContent === "string" ? task.rawContent : "",
    draftPrompt: typeof task.draftPrompt === "string" ? task.draftPrompt : "",
    createdAt: typeof task.createdAt === "string" ? task.createdAt : new Date().toISOString(),
    updatedAt: typeof task.updatedAt === "string" ? task.updatedAt : new Date().toISOString(),
  };
}

async function readTasks(): Promise<CodingTask[]> {
  const stored = await chrome.storage.local.get([TASKS_KEY, LEGACY_TASKS_KEY]);
  const tasks = stored[TASKS_KEY] ?? stored[LEGACY_TASKS_KEY];
  if (!Array.isArray(tasks)) return [];
  return tasks
    .map(normalizeTask)
    .filter((task): task is CodingTask => task !== null)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export async function listCodingTasks(): Promise<CodingTask[]> {
  return readTasks();
}

export async function saveCodingTask(
  task: CodingTask,
  options?: { forceNew?: boolean }
): Promise<void> {
  const tasks = await readTasks();
  const existingIndex = options?.forceNew
    ? -1
    : tasks.findIndex(
        (item) =>
          item.id === task.id || (Boolean(task.pageUrl) && item.pageUrl === task.pageUrl)
      );
  if (existingIndex >= 0) {
    tasks[existingIndex] = task;
  } else {
    tasks.unshift(task);
  }
  await chrome.storage.local.set({ [TASKS_KEY]: tasks });
}

export async function deleteCodingTask(taskId: string): Promise<void> {
  const tasks = await readTasks();
  await chrome.storage.local.set({
    [TASKS_KEY]: tasks.filter((task) => task.id !== taskId),
  });
}

function buildCodingTaskTitle(prompt: string, pageTitle?: string): string {
  if (pageTitle?.trim()) return pageTitle.trim();
  const oneLine = prompt.replace(/\s+/g, " ").trim();
  const max = 40;
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

export async function saveCodingPromptAsTask(input: {
  prompt: string;
  pageUrl?: string;
  pageTitle?: string;
}): Promise<void> {
  const task = createCodingTask({
    title: buildCodingTaskTitle(input.prompt, input.pageTitle),
    pageUrl: input.pageUrl ?? "",
    rawContent: input.prompt,
    draftPrompt: input.prompt,
  });
  await saveCodingTask(task, { forceNew: true });
}

export function createCodingTask(input: {
  title: string;
  pageUrl: string;
  rawContent: string;
  draftPrompt: string;
}): CodingTask {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    title: input.title,
    pageUrl: input.pageUrl,
    rawContent: input.rawContent,
    draftPrompt: input.draftPrompt,
    createdAt: now,
    updatedAt: now,
  };
}
