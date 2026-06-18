import type { JobEvent, JobStatusType } from "./types.js";

const SESSION_KEY = "codingJobSession";
const PENDING_CANCEL_KEY = "pendingServerCancelJobId";
const MAX_EVENTS = 1000;

export interface CodingJobSession {
  jobId: string;
  status: JobStatusType;
  planSummary?: string;
  events: JobEvent[];
  updatedAt: string;
}

let cachedSession: CodingJobSession | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePersist(session: CodingJobSession): void {
  cachedSession = session;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void chrome.storage.local.set({ [SESSION_KEY]: cachedSession });
  }, 300);
}

export async function getCodingJobSession(): Promise<CodingJobSession | null> {
  if (cachedSession) return cachedSession;

  const stored = await chrome.storage.local.get([SESSION_KEY]);
  const session = stored[SESSION_KEY];
  if (!session || typeof session !== "object" || typeof session.jobId !== "string") {
    return null;
  }

  if (!Array.isArray(session.events)) return null;

  cachedSession = {
    jobId: session.jobId,
    status: session.status as JobStatusType,
    planSummary: typeof session.planSummary === "string" ? session.planSummary : undefined,
    events: session.events as JobEvent[],
    updatedAt: typeof session.updatedAt === "string" ? session.updatedAt : new Date().toISOString(),
  };
  return cachedSession;
}

export async function initCodingJobSession(jobId: string, status: JobStatusType): Promise<void> {
  const session: CodingJobSession = {
    jobId,
    status,
    events: [],
    updatedAt: new Date().toISOString(),
  };
  cachedSession = session;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  await chrome.storage.local.set({ [SESSION_KEY]: session });
}

export async function clearCodingJobSession(): Promise<void> {
  cachedSession = null;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  await chrome.storage.local.remove([SESSION_KEY]);
}

export async function markPendingServerCancel(jobId: string): Promise<void> {
  await chrome.storage.local.set({ [PENDING_CANCEL_KEY]: jobId });
}

export async function clearPendingServerCancel(): Promise<void> {
  await chrome.storage.local.remove([PENDING_CANCEL_KEY]);
}

export async function getPendingServerCancelJobId(): Promise<string | undefined> {
  const stored = await chrome.storage.local.get([PENDING_CANCEL_KEY]);
  const jobId = stored[PENDING_CANCEL_KEY];
  return typeof jobId === "string" && jobId ? jobId : undefined;
}

export function appendCodingJobEvent(
  jobId: string,
  event: JobEvent,
  patch?: { status?: JobStatusType; planSummary?: string }
): void {
  const base: CodingJobSession = cachedSession?.jobId === jobId
    ? cachedSession
    : {
        jobId,
        status: patch?.status ?? "planning",
        events: [],
        updatedAt: new Date().toISOString(),
      };

  const exists = base.events.some((item) => item.id === event.id);
  const events = exists ? base.events : [...base.events, event];
  if (events.length > MAX_EVENTS) {
    events.splice(0, events.length - MAX_EVENTS);
  }

  const session: CodingJobSession = {
    ...base,
    events,
    status: patch?.status ?? base.status,
    planSummary: patch?.planSummary ?? base.planSummary,
    updatedAt: new Date().toISOString(),
  };

  schedulePersist(session);
}
