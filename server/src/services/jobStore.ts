import { v4 as uuidv4 } from "uuid";
import type { Job, JobRequest } from "../types.js";
import { loadPersistedJobs, touchJobPersistence } from "./jobPersistence.js";

const jobs = new Map<string, Job>();

function markInterruptedJobs(): void {
  for (const job of jobs.values()) {
    if (job.status === "running" || job.status === "pending") {
      jobs.set(job.jobId, {
        ...job,
        status: "failed",
        error: "服务重启导致任务中断",
        message: "服务重启导致任务中断，请重新提交",
        updatedAt: new Date().toISOString(),
      });
    }
  }
}

export function getJobsMap(): Map<string, Job> {
  return jobs;
}

export function initJobStore(): void {
  for (const job of loadPersistedJobs()) {
    jobs.set(job.jobId, job);
  }
  markInterruptedJobs();
  touchJobPersistence();
}

export function createJob(request: JobRequest): Job {
  const now = new Date().toISOString();
  const job: Job = {
    jobId: uuidv4(),
    status: "pending",
    prompt: request.prompt,
    pageContext: request.pageContext,
    submittedBy: request.submittedBy,
    attachments: request.attachments,
    requiresConfirm: false,
    createdAt: now,
    updatedAt: now,
  };
  jobs.set(job.jobId, job);
  touchJobPersistence();
  return job;
}

export function getJob(jobId: string): Job | undefined {
  return jobs.get(jobId);
}

export function updateJob(jobId: string, patch: Partial<Job>): Job | undefined {
  const job = jobs.get(jobId);
  if (!job) return undefined;

  const updated: Job = { ...job, ...patch, updatedAt: new Date().toISOString() };
  jobs.set(jobId, updated);
  touchJobPersistence();
  return updated;
}

export function listJobs(): Job[] {
  return Array.from(jobs.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}
