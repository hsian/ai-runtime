import { v4 as uuidv4 } from "uuid";
import type { Job, JobRequest } from "../types.js";

const jobs = new Map<string, Job>();

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
  return updated;
}

export function listJobs(): Job[] {
  return Array.from(jobs.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}
