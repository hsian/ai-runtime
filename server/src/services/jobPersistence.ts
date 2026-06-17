import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import type { Job } from "../types.js";
import type { JobEvent } from "./jobEvents.js";

const DATA_FILE = resolve(process.cwd(), "data", "runtime-state.json");
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface PersistedState {
  jobs: Job[];
  events: Record<string, JobEvent[]>;
}

let jobsRef: Map<string, Job> | null = null;
let eventsRef: Map<string, JobEvent[]> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function readState(): PersistedState {
  if (!existsSync(DATA_FILE)) {
    return { jobs: [], events: {} };
  }

  try {
    const raw = readFileSync(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw) as PersistedState;
    return {
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
      events: parsed.events && typeof parsed.events === "object" ? parsed.events : {},
    };
  } catch {
    return { jobs: [], events: {} };
  }
}

export function wireJobPersistence(
  jobs: Map<string, Job>,
  events: Map<string, JobEvent[]>
): void {
  jobsRef = jobs;
  eventsRef = events;
}

export function loadPersistedJobs(): Job[] {
  const cutoff = Date.now() - MAX_AGE_MS;
  return readState().jobs.filter((job) => new Date(job.updatedAt).getTime() >= cutoff);
}

export function loadPersistedJobEvents(): Map<string, JobEvent[]> {
  const validJobIds = new Set(loadPersistedJobs().map((job) => job.jobId));
  const events = new Map<string, JobEvent[]>();

  for (const [jobId, list] of Object.entries(readState().events)) {
    if (!validJobIds.has(jobId) || !Array.isArray(list)) continue;
    events.set(jobId, list);
  }

  return events;
}

export function touchJobPersistence(): void {
  if (!jobsRef || !eventsRef) return;

  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      mkdirSync(dirname(DATA_FILE), { recursive: true });
      const payload: PersistedState = {
        jobs: Array.from(jobsRef!.values()),
        events: Object.fromEntries(eventsRef!.entries()),
      };
      writeFileSync(DATA_FILE, JSON.stringify(payload), "utf8");
    } catch (err) {
      console.warn("[JobPersistence] 保存失败:", err);
    }
  }, 300);
}
