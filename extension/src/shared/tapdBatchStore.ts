import type { TapdBatchSession, TapdBatchTask } from "./types.js";

const SESSION_KEY = "tapdBatchSession";
const COMPLETED_TAPD_IDS_KEY = "tapdBatchCompletedTapdIds";

export async function loadTapdBatchSession(): Promise<TapdBatchSession | null> {
  const stored = await chrome.storage.local.get([SESSION_KEY]);
  const session = stored[SESSION_KEY];
  if (!session || typeof session !== "object") return null;
  return session as TapdBatchSession;
}

export async function saveTapdBatchSession(session: TapdBatchSession | null): Promise<void> {
  if (!session) {
    await chrome.storage.local.remove([SESSION_KEY]);
    return;
  }
  await chrome.storage.local.set({ [SESSION_KEY]: session });
}

export async function listCompletedTapdTaskIds(): Promise<Set<string>> {
  const stored = await chrome.storage.local.get([COMPLETED_TAPD_IDS_KEY]);
  const ids = stored[COMPLETED_TAPD_IDS_KEY];
  if (!Array.isArray(ids)) return new Set();
  return new Set(ids.filter((id): id is string => typeof id === "string"));
}

export async function markTapdTaskCompleted(tapdTaskId: string): Promise<void> {
  const ids = await listCompletedTapdTaskIds();
  ids.add(tapdTaskId);
  await chrome.storage.local.set({ [COMPLETED_TAPD_IDS_KEY]: [...ids] });
}

export function createBatchTask(input: {
  tapdTaskId: string;
  title: string;
  prompt: string;
  sourceHtml?: string;
  imageCount?: number;
  order: number;
}): TapdBatchTask {
  return {
    id: crypto.randomUUID(),
    tapdTaskId: input.tapdTaskId,
    title: input.title,
    prompt: input.prompt,
    sourceHtml: input.sourceHtml,
    imageCount: input.imageCount,
    order: input.order,
    status: "pending",
    completedAt: undefined,
  };
}

export function touchSession(session: TapdBatchSession): TapdBatchSession {
  return { ...session, updatedAt: new Date().toISOString() };
}
