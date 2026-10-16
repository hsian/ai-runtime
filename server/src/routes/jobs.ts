import { jobArtifactsRouter } from "./jobArtifacts.js";
import { toPublicJob } from "../services/publicJob.js";
import { authorizedJobs, isAuthorizedJob, getAuthorizedJob, getRequestOwnerId } from "./jobAccess.js";
import { workbenchQueries } from "./workbenchQueries.js";
import { subscribeJobChanges } from "../services/jobChanges.js";
import { runQuestion, runQueuedPlan, parseClarificationAnswers, resumePlannedJob, executePlannedJob, cancelOwnedJob } from "../services/jobActions.js";
import { Router } from "express";
import {
  createJob,
  deleteJob,
  getConversationContextStats,
  getJob,
  listJobs,
  updateJob,
} from "../services/jobStore.js";
import { jobQueue } from "../services/jobQueue.js";
import { appendJobEvent, deleteJobEvents, getJobEvents, subscribeJobEvents } from "../services/jobEvents.js";
import { config } from "../config.js";
import {
  cleanupStagedAttachmentsForAgent,
  deleteJobAttachments,
  finalizeJobAttachments,
  jobImagesUpload,
  multerErrorMessage,
} from "../services/uploadService.js";
import { isMultipartSubmit, parseJobSubmitBody } from "../middleware/parseJobSubmit.js";
import { revertCompletedJobFromDefaultBranch } from "../services/jobMergeService.js";
import type { JobRequest } from "../types.js";
import type { AgentProvider } from "../services/agent/index.js";
import { logOperation } from "../services/operationLog.js";
import { getClientIdentity } from "../services/clientIdentity.js";
import { getProject } from "../services/projectRegistry.js";
import { getProjectGitService } from "../services/projectRuntime.js";
import { deleteMiniProgramPreview } from "../services/miniProgramPreviewService.js";
import { receiveWorkbenchMessage, pauseWorkbenchSession, assertWorkbenchCanReceive } from "../services/workbenchSession.js";
import { getAuthUser, requireSameOrigin } from "../services/auth.js";
import { syncWorkbenchTask } from "../services/tapd/taskStatusSync.js";
import { z } from "zod";
import { requestTaskMerge, releaseTaskToBranch } from "../services/taskOperations.js";


function getJobAgentProvider(job: Pick<JobRequest, "agentProvider">): AgentProvider {
  return job.agentProvider ?? config.AGENT_PROVIDER;
}

function getPublicJob(jobId: string) {
  const job = getJob(jobId);
  return job ? toPublicJob(job) : undefined;
}

function handleJobImagesUpload(
  req: import("express").Request,
  res: import("express").Response,
  next: import("express").NextFunction
): void {
  if (!isMultipartSubmit(req)) {
    next();
    return;
  }

  jobImagesUpload.array("images")(req, res, (err) => {
    if (err) {
      res.status(400).json({ error: multerErrorMessage(err) });
      return;
    }
    next();
  });
}

function createJobFromSubmit(
  req: import("express").Request
): { job: NonNullable<ReturnType<typeof getJob>>; data: JobRequest } | { error: string } {
  const parsed = parseJobSubmitBody(req);
  if (parsed.error || !parsed.data) {
    return { error: parsed.error ?? "参数无效" };
  }

  const files = isMultipartSubmit(req)
    ? (req.files as Express.Multer.File[] | undefined)
    : undefined;

  const identity = getClientIdentity(req);
  const job = createJob({ ...parsed.data, ownerId: identity.ownerId, remoteIp: identity.remoteIp });
  const previewHost = req.get("x-forwarded-host") ?? req.get("host");
  if (previewHost) {
    updateJob(job.jobId, { previewHost });
    job.previewHost = previewHost;
  }
  const attachments = finalizeJobAttachments(job.jobId, files);
  if (attachments.length > 0) {
    updateJob(job.jobId, { attachments });
    job.attachments = attachments;
  }

  return { job, data: { ...parsed.data, attachments } };
}

function emitUserSubmitEvents(jobId: string, data: JobRequest): void {
  const attachmentCount = data.attachments?.length ?? 0;

  appendJobEvent(jobId, {
    type: "user",
    text: data.prompt,
    pageUrl: data.pageContext?.url,
    attachmentCount: attachmentCount > 0 ? attachmentCount : undefined,
  });

  if (attachmentCount > 0) {
    appendJobEvent(jobId, {
      type: "stage",
      phase: "attachments",
      text: `已接收 ${attachmentCount} 张截图`,
    });
  }
}

export const jobsRouter = Router();
jobsRouter.use("/workbench", workbenchQueries);
jobsRouter.use(jobArtifactsRouter);

jobsRouter.post("/workbench", handleJobImagesUpload, (req, res) => {
  const user = getAuthUser(req);
  if (!user) { res.status(401).json({ error: "请先登录任务工作台" }); return; }
  const text = typeof req.body?.message === "string" ? req.body.message.trim() : "请开始处理这个需求。";
  if (!text || text.length > 20000) { res.status(400).json({ error: "消息应为 1–20000 个字符" }); return; }
  const parsed = parseJobSubmitBody(req);
  if (parsed.error || !parsed.data) { res.status(400).json({ error: parsed.error }); return; }
  const identity = getClientIdentity(req);
  const existing = authorizedJobs(req).find(job => job.workbenchSession && job.conversationId === parsed.data!.conversationId && job.projectId === parsed.data!.projectId);
  if (existing) { res.status(409).json({ error: "该任务已有会话，请进入现有会话继续", jobId: existing.jobId }); return; }
  const created = createJobFromSubmit(req);
  if ("error" in created) { res.status(400).json({ error: created.error }); return; }
  const { job } = created;
  updateJob(job.jobId, { workbenchSession: true, workbenchUserId: user.id, tapdTask: parsed.data.tapdTask, tapdOperator: user.tapdOwnerName, taskMode: parsed.data.taskMode || "code", status: "awaiting_input" });
  receiveWorkbenchMessage(job.jobId, text);
  res.status(202).json({ jobId: job.jobId, status: "planning", message: "已开始处理任务" });
});

jobsRouter.post("/:jobId/message", handleJobImagesUpload, (req, res) => {
  const job = getAuthorizedJob(req, res);
  if (!job) return;
  const user = getAuthUser(req);
  if (!user) { res.status(401).json({ error: "请先登录任务工作台" }); return; }
  if (!job.workbenchUserId && job.tapdOperator && job.tapdOperator !== user.tapdOwnerName) {
    res.status(409).json({ error: "旧任务的 TAPD 操作人与当前账号不一致，请使用原账号继续" }); return;
  }
  const text = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  if (!text || text.length > 20000) { res.status(400).json({ error: "消息应为 1–20000 个字符" }); return; }
  try {
    assertWorkbenchCanReceive(job.jobId);
    // An explicit authenticated reply claims a legacy browser-owned session.
    // Merely listing/opening a job never guesses an account or enables a push.
    if (!job.workbenchUserId) updateJob(job.jobId, { workbenchUserId: user.id, tapdOperator: user.tapdOwnerName });
    const files = isMultipartSubmit(req) ? req.files as Express.Multer.File[] | undefined : undefined;
    const attachments = finalizeJobAttachments(job.jobId, files, job.attachments?.length ?? 0);
    receiveWorkbenchMessage(job.jobId, text, attachments);
    res.status(202).json({ jobId: job.jobId, status: getJob(job.jobId)?.status, message: "消息已收到" });
  } catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); }
});

jobsRouter.post("/:jobId/pause", (req, res) => {
  const job = getAuthorizedJob(req, res);
  if (!job) return;
  try { pauseWorkbenchSession(job.jobId); res.json({ ok: true }); }
  catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); }
});

jobsRouter.patch("/:jobId/engine", requireSameOrigin, (req, res) => {
  const job = getAuthorizedJob(req, res);
  if (!job) return;
  const user = getAuthUser(req);
  if (!user) { res.status(401).json({ error: "请先登录任务工作台" }); return; }
  if (!job.workbenchSession || (job.workbenchUserId && job.workbenchUserId !== user.id)) { res.status(409).json({ error: "只能切换自己的工作台会话引擎" }); return; }
  if (!job.workbenchUserId && job.tapdOperator && job.tapdOperator !== user.tapdOwnerName) { res.status(409).json({ error: "旧任务的操作人与当前账号不一致" }); return; }
  const input = z.object({ agentProvider: z.enum(["codex", "claude"]) }).safeParse(req.body);
  if (!input.success) { res.status(400).json({ error: "请选择有效的模型引擎" }); return; }
  if (job.workbenchTurnRunning || ["planning", "pending", "running"].includes(job.status)) { res.status(409).json({ error: "当前轮仍在处理，请停止并等待结束后切换引擎" }); return; }
  updateJob(job.jobId, { agentProvider: input.data.agentProvider, workbenchUserId: user.id, tapdOperator: job.tapdOperator || user.tapdOwnerName });
  res.json({ agentProvider: input.data.agentProvider });
});

jobsRouter.post("/", handleJobImagesUpload, (req, res) => {
  const created = createJobFromSubmit(req);
  if ("error" in created) {
    res.status(400).json({ error: created.error });
    return;
  }

  const { job, data } = created;
  updateJob(job.jobId, { taskMode: "question" });
  emitUserSubmitEvents(job.jobId, data);
  logOperation({
    action: "job_submit",
    status: "success",
    jobId: job.jobId,
    ownerId: job.ownerId,
    mode: "question",
    attachmentCount: data.attachments?.length,
    engine: getJobAgentProvider(data),
  });

  void runQuestion(job.jobId);

  res.status(202).json({
    jobId: job.jobId,
    status: "running",
    message: "已进入项目问答（只读，不修改代码）",
    jobsAhead: 0,
  });
});

jobsRouter.post("/plan", handleJobImagesUpload, (req, res) => {
  const created = createJobFromSubmit(req);
  if ("error" in created) {
    res.status(400).json({ error: created.error });
    return;
  }

  const { job, data } = created;
  updateJob(job.jobId, { taskMode: "code", requiresConfirm: true, status: "planning" });
  emitUserSubmitEvents(job.jobId, data);
  logOperation({
    action: "job_submit",
    status: "success",
    jobId: job.jobId,
    ownerId: job.ownerId,
    mode: "plan",
    attachmentCount: data.attachments?.length,
    engine: getJobAgentProvider(data),
  });

  void runQueuedPlan(job.jobId);

  res.status(202).json({
    jobId: job.jobId,
    status: "planning",
    message: "已进入 Plan 分析（不改代码），完成后可确认执行",
    jobsAhead: 0,
  });
});

jobsRouter.post("/:jobId/clarify", handleJobImagesUpload, (req, res) => {
  const jobId = req.params.jobId;
  const job = getAuthorizedJob(req, res);
  if (!job) return;
  if (job.status !== "awaiting_input" || !job.clarificationQuestions?.length) {
    res.status(400).json({ error: `当前状态不需要补充信息: ${job.status}` });
    return;
  }

  const parsed = parseClarificationAnswers(req.body?.answers, job);
  if (parsed.error || !parsed.answers) {
    res.status(400).json({ error: parsed.error ?? "补充答案无效" });
    return;
  }
  const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 5_000) : "";
  const files = isMultipartSubmit(req)
    ? (req.files as Express.Multer.File[] | undefined)
    : undefined;
  const addedAttachments = finalizeJobAttachments(jobId, files, job.attachments?.length ?? 0);
  resumePlannedJob(jobId, job.ownerId, parsed.answers, note, addedAttachments);

  res.status(202).json({
    jobId,
    status: "planning",
    message: "已收到补充信息，正在继续生成修改方案",
    jobsAhead: 0,
  });
});

jobsRouter.post("/:jobId/execute", (req, res) => {
  const job = getAuthorizedJob(req, res);
  if (!job) return;
  try {
    executePlannedJob(job.jobId, job.ownerId, req.body);
    res.status(202).json({ jobId: job.jobId, status: "pending", message: "已确认执行，正在准备独立工作区", jobsAhead: 0 });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

jobsRouter.post("/:jobId/cancel", async (req, res) => {
  const job = getAuthorizedJob(req, res);
  if (!job) return;
  try {
    await cancelOwnedJob(job.jobId, job.ownerId);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

jobsRouter.delete("/conversation/:conversationId", async (req, res) => {
  const ownerId = getRequestOwnerId(req);
  const conversationId = req.params.conversationId;
  const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
  let resolvedProjectId: string;
  try { resolvedProjectId = getProject(projectId).id; }
  catch (err) { res.status(400).json({ error: err instanceof Error ? err.message : "项目无效" }); return; }
  const jobs = authorizedJobs(req).filter(
    (job) => job.projectId === resolvedProjectId && (job.conversationId || job.jobId) === conversationId
  );
  if (jobs.length === 0) {
    res.status(404).json({ error: "任务不存在" });
    return;
  }

  const deletableStatuses = new Set(["completed", "failed", "cancelled", "awaiting_confirm", "awaiting_input"]);
  const blocked = jobs.find((job) => job.workbenchTurnRunning || !deletableStatuses.has(job.status));
  if (blocked) {
    const message = blocked.status === "awaiting_merge"
      ? blocked.workbenchSession ? "对话还有待审查的改动，请先完成或退回未开始再删除" : "任务正在等待合并处理，请先合并或放弃合并"
      : "任务仍在执行，请先取消后再删除";
    res.status(409).json({ error: message });
    return;
  }

  for (const job of jobs) {
    const gitService = getProjectGitService(job.projectId);
    await deleteJobAttachments(job.jobId).catch(() => undefined);
    await deleteMiniProgramPreview(job.jobId).catch(() => undefined);
    await cleanupStagedAttachmentsForAgent(gitService.getRepoPath(), job.jobId).catch(() => undefined);
    if (job.workbenchSession && job.worktreePath) await gitService.removeJobWorktree(job.worktreePath, job.branch);
    deleteJobEvents(job.jobId);
    deleteJob(job.jobId);
  }
  logOperation({
    action: "job_delete",
    status: "success",
    jobId: jobs[0]?.jobId,
    ownerId,
    message: `deleted_conversation_jobs:${jobs.length}`,
  });
  res.json({ ok: true, deleted: jobs.length });
});

jobsRouter.post("/:jobId/tapd-sync", async (req, res) => {
  const job = getAuthorizedJob(req, res);
  if (!job) return;
  if (!job.workbenchSession || (!job.tapdTask && job.tapdContext?.itemType !== "bug") || !job.tapdSync || job.tapdSync.state !== "failed") { res.status(409).json({ error: "当前没有失败的 TAPD 同步" }); return; }
  await syncWorkbenchTask(job.jobId, job.tapdSync.target);
  const latest = getJob(job.jobId)!;
  if (latest.tapdSync?.state === "failed") { res.status(502).json({ error: latest.tapdSync.error }); return; }
  res.json({ ok: true });
});

jobsRouter.post("/:jobId/merge", (req, res) => {
  const jobId = req.params.jobId;
  const job = getAuthorizedJob(req, res);
  if (!job) return;

  if (job.status !== "awaiting_merge") {
    res.status(400).json({ error: `当前状态不可合并: ${job.status}` });
    return;
  }

  if (job.workbenchSession && (!job.commitSha || job.workbenchHasCodeChanges === false || job.commitSha === job.workbenchBaseCommitSha)) {
    res.status(409).json({ error: "还没有实际代码修改，不能完成或合并任务" }); return;
  }

  const body = req.body as { createMergeRequest?: unknown; tapdTask?: unknown } | undefined;
  if (job.workbenchSession && !job.tapdTask && body?.tapdTask) {
    const target = z.object({ workspaceId: z.string().regex(/^\d+$/), taskId: z.string().regex(/^\d+$/) }).safeParse(body.tapdTask);
    if (!target.success) { res.status(400).json({ error: "TAPD 任务关联无效" }); return; }
    updateJob(jobId, { tapdTask: target.data, tapdOperator: getAuthUser(req)?.tapdOwnerName });
  }
  const retryingMerge = job.mergeRetryable === true;
  const createMergeRequest = !retryingMerge && body?.createMergeRequest === true;

  let jobsAhead: number;
  try { jobsAhead = requestTaskMerge(jobId, { createMergeRequest }); }
  catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); return; }

  res.status(202).json({
    jobId,
    status: "pending",
    message: jobsAhead > 0
      ? `已加入队列，前面还有 ${jobsAhead} 个任务`
      : retryingMerge
        ? "正在重试合并..."
        : createMergeRequest
          ? "已确认提交 Merge Request，即将处理..."
          : "已确认合并，即将处理...",
    jobsAhead,
  });
});

jobsRouter.post("/:jobId/discard-merge", async (req, res) => {
  const jobId = req.params.jobId;
  const job = getAuthorizedJob(req, res);
  if (!job) return;

  if (job.status !== "awaiting_merge") {
    res.status(400).json({ error: `当前状态不可放弃合并: ${job.status}` });
    return;
  }

  let jobsAhead: number;
  try { jobsAhead = requestTaskMerge(jobId, { discard: true }); }
  catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); return; }

  res.status(202).json({
    ok: true,
    status: "pending",
    message: jobsAhead > 0 ? `已加入队列，前面还有 ${jobsAhead} 个任务` : "已确认放弃合并，即将处理...",
    jobsAhead,
  });
});

jobsRouter.get("/:jobId/release-branches", async (req, res) => {
  const job = getAuthorizedJob(req, res);
  if (!job) return;

  try {
    const gitService = getProjectGitService(job.projectId);
    const project = getProject(job.projectId);
    const branches = await gitService.listRemoteBranches();
    const mergedBranches = new Set(
      (job.releaseMerges ?? [])
        .filter((record) => record.status === "completed")
        .map((record) => record.targetBranch)
    );
    res.json({
      branches: branches.filter(
        (branch) =>
          branch !== project.defaultBranch &&
          branch !== job.sourceBranch &&
          !mergedBranches.has(branch)
      ),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

jobsRouter.post("/:jobId/release-merge", async (req, res) => {
  const jobId = req.params.jobId;
  const job = getAuthorizedJob(req, res);
  if (!job) return;

  const body = req.body as { targetBranch?: unknown } | undefined;
  const targetBranch = typeof body?.targetBranch === "string" ? body.targetBranch.trim() : "";
  if (!targetBranch) {
    res.status(400).json({ error: "请选择目标分支" });
    return;
  }

  try {
    await releaseTaskToBranch(jobId, targetBranch);
    res.json({ ok: true, job: getPublicJob(jobId) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err), job: getPublicJob(jobId) });
  }
});

jobsRouter.post("/:jobId/revert-default", async (req, res) => {
  const jobId = req.params.jobId;
  const job = getAuthorizedJob(req, res);
  if (!job) return;

  try {
    const { done } = jobQueue.enqueueAndWait(jobId, async (queuedJobId) => {
      await revertCompletedJobFromDefaultBranch(queuedJobId);
    });
    await done;
    res.json({ ok: true, job: getPublicJob(jobId) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err), job: getPublicJob(jobId) });
  }
});

jobsRouter.get("/context-stats/:conversationId", (req, res) => {
  res.json(
    getConversationContextStats(
      getRequestOwnerId(req),
      req.params.conversationId,
      typeof req.query.projectId === "string" ? req.query.projectId : undefined
    )
  );
});

jobsRouter.get("/:jobId/events", (req, res) => {
  const job = getAuthorizedJob(req, res);
  if (!job) return;

  res.json({ events: getJobEvents(job.jobId) });
});

jobsRouter.get("/:jobId/stream", (req, res) => {
  const jobId = req.params.jobId;
  const job = getAuthorizedJob(req, res);
  if (!job) return;

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const writeEvent = (event: unknown): void => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // State-only updates (actor finished, pause, engine change) need no polling.
  const writeState = () => {
    const latest = getJob(jobId);
    if (latest && isAuthorizedJob(latest, getRequestOwnerId(req), getAuthUser(req)?.id)) res.write(`event: state\ndata: ${JSON.stringify(toPublicJob(latest))}\n\n`);
  };
  writeState();
  let stateTimer: ReturnType<typeof setTimeout> | undefined;
  const unsubscribeState = subscribeJobChanges(id => {
    if (id !== jobId || stateTimer) return;
    stateTimer = setTimeout(() => { stateTimer = undefined; writeState(); }, 100);
  });

  for (const event of getJobEvents(jobId)) {
    writeEvent(event);
  }

  if (jobQueue.getJobsAhead(jobId) != null) {
    jobQueue.broadcastQueue(jobId);
  }

  const unsubscribe = subscribeJobEvents(jobId, (event) => {
    writeEvent(event);
    if (!job.workbenchSession && req.query.continuous !== "true" && (event.type === "done" || event.type === "cancelled" || event.type === "error")) {
      res.write("event: close\ndata: {}\n\n");
    }
  });

  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, 25_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    clearTimeout(stateTimer);
    unsubscribeState();
    unsubscribe();
  });
});

jobsRouter.get("/changes", (req, res) => {
  const ownerId = getRequestOwnerId(req);
  const userId = getAuthUser(req)?.id;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  res.write(": ready\n\n");
  const unsubscribe = subscribeJobChanges(id => {
    const job = getJob(id);
    if (job && !job.workbenchSession && isAuthorizedJob(job, ownerId, userId)) res.write(`data: ${JSON.stringify({ jobId: id })}\n\n`);
  });
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);
  req.on("close", () => { clearInterval(heartbeat); unsubscribe(); });
});

jobsRouter.get("/:jobId", (req, res) => {
  const job = getAuthorizedJob(req, res);
  if (!job) return;
  res.json(toPublicJob(job));
});

jobsRouter.get("/", (req, res) => {
  res.json({ jobs: authorizedJobs(req).map(toPublicJob) });
});
