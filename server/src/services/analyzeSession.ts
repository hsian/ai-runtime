import { randomUUID } from "crypto";
import { abortRequirementPolish } from "./requirementTextPolisher.js";

export type AnalyzeSessionStatus = "running" | "completed" | "failed" | "cancelled";

export type AnalyzeEventType = "stage" | "agent_text" | "agent_tool" | "done" | "cancelled" | "error";

export interface AnalyzeEvent {
  id: string;
  sessionId: string;
  timestamp: string;
  type: AnalyzeEventType;
  text?: string;
  phase?: string;
  delta?: string;
  toolAction?: "start" | "done";
  toolName?: string;
  toolDetail?: string;
  draftPrompt?: string;
  message?: string;
}

export type AnalyzeEventInput = Omit<AnalyzeEvent, "id" | "sessionId" | "timestamp">;

export interface AnalyzeSession {
  sessionId: string;
  status: AnalyzeSessionStatus;
  draftPrompt?: string;
  imageCount: number;
  message?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

const MAX_EVENTS = 500;
const SESSION_TTL_MS = 60 * 60 * 1000;

const sessions = new Map<string, AnalyzeSession>();
const events = new Map<string, AnalyzeEvent[]>();
const subscribers = new Map<string, Set<(event: AnalyzeEvent) => void>>();

function touchSession(session: AnalyzeSession): void {
  session.updatedAt = new Date().toISOString();
}

export function createAnalyzeSession(imageCount: number, sessionId = randomUUID()): AnalyzeSession {
  const now = new Date().toISOString();
  const session: AnalyzeSession = {
    sessionId,
    status: "running",
    imageCount,
    message: "分析已开始",
    createdAt: now,
    updatedAt: now,
  };
  sessions.set(sessionId, session);
  return session;
}

export function getAnalyzeSession(sessionId: string): AnalyzeSession | undefined {
  return sessions.get(sessionId);
}

export function updateAnalyzeSession(
  sessionId: string,
  patch: Partial<Pick<AnalyzeSession, "status" | "draftPrompt" | "message" | "error">>
): AnalyzeSession | undefined {
  const session = sessions.get(sessionId);
  if (!session) return undefined;
  Object.assign(session, patch);
  touchSession(session);
  return session;
}

export function appendAnalyzeEvent(sessionId: string, input: AnalyzeEventInput): AnalyzeEvent {
  const event: AnalyzeEvent = {
    id: randomUUID(),
    sessionId,
    timestamp: new Date().toISOString(),
    ...input,
  };

  const list = events.get(sessionId) ?? [];
  list.push(event);
  if (list.length > MAX_EVENTS) {
    list.splice(0, list.length - MAX_EVENTS);
  }
  events.set(sessionId, list);

  const session = sessions.get(sessionId);
  if (session) {
    touchSession(session);
  }

  const subs = subscribers.get(sessionId);
  if (subs) {
    for (const cb of subs) {
      try {
        cb(event);
      } catch (err) {
        console.warn("[AnalyzeSession] subscriber error:", err);
      }
    }
  }

  return event;
}

export function getAnalyzeEvents(sessionId: string): AnalyzeEvent[] {
  return events.get(sessionId) ?? [];
}

export function subscribeAnalyzeEvents(
  sessionId: string,
  callback: (event: AnalyzeEvent) => void
): () => void {
  let subs = subscribers.get(sessionId);
  if (!subs) {
    subs = new Set();
    subscribers.set(sessionId, subs);
  }
  subs.add(callback);

  return () => {
    subs?.delete(callback);
    if (subs?.size === 0) {
      subscribers.delete(sessionId);
    }
  };
}

export function cancelAnalyzeSession(sessionId: string): AnalyzeSession | undefined {
  const session = sessions.get(sessionId);
  if (!session) return undefined;

  if (session.status === "completed" || session.status === "failed" || session.status === "cancelled") {
    return session;
  }

  abortRequirementPolish(sessionId);
  session.status = "cancelled";
  session.message = "整理已取消";
  touchSession(session);

  appendAnalyzeEvent(sessionId, {
    type: "cancelled",
    text: "整理已取消",
    message: "整理已取消",
  });

  return session;
}

export function purgeExpiredAnalyzeSessions(): void {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [sessionId, session] of sessions) {
    if (new Date(session.updatedAt).getTime() < cutoff) {
      sessions.delete(sessionId);
      events.delete(sessionId);
      subscribers.delete(sessionId);
    }
  }
}

setInterval(purgeExpiredAnalyzeSessions, 15 * 60 * 1000).unref();
