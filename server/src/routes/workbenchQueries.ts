import { Router } from "express";
import { getAuthUser } from "../services/auth.js";
import { getJob, listWorkbenchSummaries, listConversationJobs } from "../services/jobStore.js";
import { subscribeJobChanges } from "../services/jobChanges.js";
import { toPublicJob, toJobSummary } from "../services/publicJob.js";
import { isAuthorizedJob, getRequestOwnerId } from "./jobAccess.js";

export const workbenchQueries = Router();
workbenchQueries.use((req, res, next) => {
  if (!getAuthUser(req)) { res.status(401).json({ error: "请先登录工作台" }); return; }
  next();
});
workbenchQueries.get("/conversations/:conversationId", (req, res) => {
  const projectId = typeof req.query.projectId === "string" ? req.query.projectId : "";
  if (!projectId) { res.status(400).json({ error: "缺少代码项目" }); return; }
  const jobs = listConversationJobs(req.params.conversationId, projectId, getAuthUser(req)!.id, getRequestOwnerId(req));
  res.setHeader("Cache-Control", "private, no-store");
  res.json({ jobs: jobs.map(toPublicJob) });
});
workbenchQueries.get("/jobs", (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  res.json({ jobs: listWorkbenchSummaries(getAuthUser(req)!.id, getRequestOwnerId(req)).map(job => {
    const summary = toJobSummary(job);
    return { ...summary, conversationTitle: (job as typeof job & { conversationTitle?: string }).conversationTitle?.slice(0, 60) || summary.conversationTitle };
  }) });
});
workbenchQueries.get("/changes", (req, res) => {
  const userId = getAuthUser(req)!.id;
  const ownerId = getRequestOwnerId(req);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  const write = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const jobs = listWorkbenchSummaries(userId, ownerId).map(job => ({ ...toJobSummary(job),
    conversationTitle: (job as typeof job & { conversationTitle?: string }).conversationTitle?.slice(0, 60) || job.prompt.slice(0, 60) }));
  const visible = new Set(jobs.map(job => job.jobId));
  write("snapshot", { jobs });
  const unsubscribe = subscribeJobChanges(id => {
    const job = getJob(id);
    if (job?.workbenchSession && isAuthorizedJob(job, ownerId, userId)) {
      visible.add(id); write("upsert", toJobSummary(job));
    } else if (visible.delete(id)) write("remove", { jobId: id });
  });
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);
  req.on("close", () => { clearInterval(heartbeat); unsubscribe(); });
});
