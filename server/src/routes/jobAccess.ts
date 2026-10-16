import type { Request, Response } from "express";
import type { Job } from "../types.js";
import { getJob, listJobs } from "../services/jobStore.js";
import { getAuthUser } from "../services/auth.js";
import { getClientIdentity } from "../services/clientIdentity.js";

export const getRequestOwnerId = (req: Request) => getClientIdentity(req).ownerId;
export function isAuthorizedJob(job: Job, ownerId: string, userId?: string): boolean {
  if (job.workbenchUserId) return job.workbenchUserId === userId;
  return !job.ownerId || job.ownerId === ownerId;
}
export const authorizedJobs = (req: Request) => listJobs().filter(job => isAuthorizedJob(job, getRequestOwnerId(req), getAuthUser(req)?.id));
export function getAuthorizedJob(req: Request, res: Response): Job | undefined {
  const job = getJob(req.params.jobId);
  if (!job || !isAuthorizedJob(job, getRequestOwnerId(req), getAuthUser(req)?.id)) { res.status(404).json({ error: "任务不存在" }); return; }
  return job;
}
