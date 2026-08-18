import { randomUUID } from "crypto";

import { getDatabase } from "./database.js";

export type JobEventType =
  | "user"
  | "queue"
  | "stage"
  | "agent_text"
  | "agent_tool"
  | "agent_status"
  | "done"
  | "cancelled"
  | "error";

export interface QueueItemSummary {
  jobId: string;
  prompt: string;
  jobsAhead: number;
}

export interface JobEvent {
  id: string;
  jobId: string;
  timestamp: string;
  type: JobEventType;
  text?: string;
  pageUrl?: string;
  phase?: string;
  delta?: string;
  statusText?: string;
  toolAction?: "start" | "done";
  toolName?: string;
  toolDetail?: string;
  jobsAhead?: number;
  running?: QueueItemSummary | null;
  waiting?: QueueItemSummary[];
  branch?: string;
  commitSha?: string;
  mergeRequestUrl?: string;
  previewUrl?: string;
  previewMessage?: string;
  mergeRetryable?: boolean;
  message?: string;
  attachmentCount?: number;
}

export type JobEventInput = Omit<JobEvent, "id" | "jobId" | "timestamp">;

const MAX_EVENTS_PER_JOB = 1000;
const subscribers = new Map<string, Set<(event: JobEvent) => void>>();

export function appendJobEvent(jobId: string, input: JobEventInput): JobEvent {
  const event: JobEvent = {
    id: randomUUID(),
    jobId,
    timestamp: new Date().toISOString(),
    ...input,
  };

  const db = getDatabase();
  const persist = db.transaction(() => {
    db.prepare(`
      INSERT INTO job_events (id, job_id, timestamp, data)
      VALUES (?, ?, ?, ?)
    `).run(event.id, event.jobId, event.timestamp, JSON.stringify(event));
    db.prepare(`
      DELETE FROM job_events
      WHERE job_id = ?
        AND sequence NOT IN (
          SELECT sequence
          FROM job_events
          WHERE job_id = ?
          ORDER BY sequence DESC
          LIMIT ?
        )
    `).run(jobId, jobId, MAX_EVENTS_PER_JOB);
  });
  persist();

  const subs = subscribers.get(jobId);
  if (subs) {
    for (const cb of subs) {
      try {
        cb(event);
      } catch (err) {
        console.warn("[JobEvents] subscriber error:", err);
      }
    }
  }

  return event;
}

export function getJobEvents(jobId: string): JobEvent[] {
  const rows = getDatabase()
    .prepare("SELECT data FROM job_events WHERE job_id = ? ORDER BY sequence")
    .all(jobId) as Array<{ data: string }>;
  return rows.map((row) => JSON.parse(row.data) as JobEvent);
}

export function deleteJobEvents(jobId: string): void {
  getDatabase().prepare("DELETE FROM job_events WHERE job_id = ?").run(jobId);
}

export function subscribeJobEvents(
  jobId: string,
  callback: (event: JobEvent) => void
): () => void {
  let subs = subscribers.get(jobId);
  if (!subs) {
    subs = new Set();
    subscribers.set(jobId, subs);
  }
  subs.add(callback);

  return () => {
    subs?.delete(callback);
    if (subs?.size === 0) {
      subscribers.delete(jobId);
    }
  };
}
