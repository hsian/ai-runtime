import type { RequirementTask } from "./types.js";

const TASKS_KEY = "requirementTasks";

export async function listRequirementTasks(): Promise<RequirementTask[]> {
  const stored = await chrome.storage.local.get([TASKS_KEY]);
  const tasks = stored[TASKS_KEY];
  if (!Array.isArray(tasks)) return [];

  return tasks
    .filter((task): task is RequirementTask => Boolean(task && typeof task === "object" && task.id))
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export async function saveRequirementTask(
  task: RequirementTask,
  options?: { forceNew?: boolean }
): Promise<void> {
  const tasks = await listRequirementTasks();
  const existingIndex = options?.forceNew
    ? -1
    : tasks.findIndex(
        (item) =>
          item.id === task.id || (Boolean(task.tapdUrl) && item.tapdUrl === task.tapdUrl)
      );
  if (existingIndex >= 0) {
    tasks[existingIndex] = task;
  } else {
    tasks.unshift(task);
  }
  await chrome.storage.local.set({ [TASKS_KEY]: tasks });
}

export async function deleteRequirementTask(taskId: string): Promise<void> {
  const tasks = await listRequirementTasks();
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

/** 编码模式确认发送后写入任务列表，便于清屏后从历史中找回 */
export async function saveCodingPromptAsTask(input: {
  prompt: string;
  pageUrl?: string;
  pageTitle?: string;
}): Promise<void> {
  const task = createRequirementTask({
    title: buildCodingTaskTitle(input.prompt, input.pageTitle),
    tapdUrl: input.pageUrl ?? "",
    rawContent: input.prompt,
    draftPrompt: input.prompt,
  });
  await saveRequirementTask(task, { forceNew: true });
}

export function createRequirementTask(input: {
  title: string;
  tapdUrl: string;
  rawContent: string;
  draftPrompt: string;
}): RequirementTask {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    title: input.title,
    tapdUrl: input.tapdUrl,
    rawContent: input.rawContent,
    draftPrompt: input.draftPrompt,
    createdAt: now,
    updatedAt: now,
  };
}
