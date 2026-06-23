import { randomUUID } from "crypto";

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
  message?: string;
  attachmentCount?: number;
}

export type JobEventInput = Omit<JobEvent, "id" | "jobId" | "timestamp">;

const MAX_EVENTS_PER_JOB = 1000;
const events = new Map<string, JobEvent[]>();
const subscribers = new Map<string, Set<(event: JobEvent) => void>>();

export function getJobEventsMap(): Map<string, JobEvent[]> {
  return events;
}

export function appendJobEvent(jobId: string, input: JobEventInput): JobEvent {
  const event: JobEvent = {
    id: randomUUID(),
    jobId,
    timestamp: new Date().toISOString(),
    ...input,
  };

  const list = events.get(jobId) ?? [];
  list.push(event);
  if (list.length > MAX_EVENTS_PER_JOB) {
    list.splice(0, list.length - MAX_EVENTS_PER_JOB);
  }
  events.set(jobId, list);

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
  return events.get(jobId) ?? [];
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
