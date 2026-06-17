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

export async function saveRequirementTask(task: RequirementTask): Promise<void> {
  const tasks = await listRequirementTasks();
  const existingIndex = tasks.findIndex((item) => item.id === task.id || item.tapdUrl === task.tapdUrl);
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
