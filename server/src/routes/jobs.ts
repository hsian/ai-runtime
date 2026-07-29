import { Router } from "express";
import { createJob, getJob, listJobs, updateJob } from "../services/jobStore.js";
import { jobQueue } from "../services/jobQueue.js";
import { processJob } from "../services/jobProcessor.js";
import { appendJobEvent, getJobEvents, subscribeJobEvents } from "../services/jobEvents.js";
import { gitService } from "../services/gitService.js";
import { runAgent, killAgentForJob, AgentAbortedError } from "../services/agent/index.js";
import { config } from "../config.js";
import {
  cleanupStagedAttachmentsForAgent,
  finalizeJobAttachments,
  jobImagesUpload,
  multerErrorMessage,
  stageAttachmentsForAgent,
} from "../services/uploadService.js";
import { isMultipartSubmit, parseJobSubmitBody } from "../middleware/parseJobSubmit.js";
import { confirmJobMerge, createJobMergeRequest, discardJobMerge, mergeCompletedJobToBranch, revertCompletedJobFromDefaultBranch } from "../services/jobMergeService.js";
import type { JobRequest } from "../types.js";
import { resolvePlanSummary } from "../services/agent/planSummaryResolver.js";

function getRequestOwnerId(req: import("express").Request): string {
  const headerValue = req.get("x-ai-runtime-client-id");
  const queryValue = req.query.clientId;
  const raw =
    headerValue ??
    (typeof queryValue === "string" ? queryValue : undefined) ??
    "anonymous";
  const ownerId = raw.trim().slice(0, 128);
  return ownerId || "anonymous";
}

function isAuthorizedJob(
  job: NonNullable<ReturnType<typeof getJob>>,
  ownerId: string
): boolean {
  return !job.ownerId || job.ownerId === ownerId;
}

function getAuthorizedJob(
  req: import("express").Request,
  res: import("express").Response
): NonNullable<ReturnType<typeof getJob>> | undefined {
  const job = getJob(req.params.jobId);
  if (!job || !isAuthorizedJob(job, getRequestOwnerId(req))) {
    res.status(404).json({ error: "任务不存在" });
    return undefined;
  }
  return job;
}

async function revertPlanWorkspaceChanges(jobId: string, reason: string): Promise<void> {
  const job = getJob(jobId);
  const reverted = await gitService.discardUncommittedChanges(job?.worktreePath);
  if (reverted.length === 0) return;

  const fileList = reverted.slice(0, 5).join(", ");
  const suffix = reverted.length > 5 ? ` 等 ${reverted.length} 个文件` : "";
  appendJobEvent(jobId, {
    type: "stage",
    phase: "plan_cleanup",
    text: `${reason}，已自动还原工作区改动：${fileList}${suffix}`,
  });
}

async function runPlan(jobId: string): Promise<void> {
  const job = updateJob(jobId, { status: "planning", requiresConfirm: true, jobsAhead: undefined });
  if (!job) return;
  let shouldCleanupWorkspace = false;

  const trimmed = job.prompt.trim();
  const looksLikeGreeting = /^(你好|您好|hi|hello|test|测试|在吗|在不在)\b/i.test(trimmed) || trimmed.length < 4;
  if (looksLikeGreeting) {
    updateJob(jobId, {
      status: "awaiting_input",
      planSummary: "需求过于简单（例如仅“你好/测试”），无法判断要改什么。请补充：要改哪个模块？具体要改成什么效果？期望页面/按钮/字段是什么？",
      message: "Plan 需要补充信息：请描述具体改动",
    });
    appendJobEvent(jobId, {
      type: "stage",
      phase: "plan_need_more",
      text: "Plan 需要补充信息：当前描述过短，请补充具体改动后重新提交",
    });
    return;
  }

  try {
    const defaultBranch = config.GIT_DEFAULT_BRANCH;
    const pullText = `Plan 模式：正在拉取 ${defaultBranch} 分支最新代码...`;
    updateJob(jobId, { message: pullText });
    appendJobEvent(jobId, { type: "stage", phase: "pull", text: pullText });
    await gitService.prepareBaseBranch();

    appendJobEvent(jobId, { type: "stage", phase: "plan", text: "Plan 模式：正在分析改动方案（不创建分支、不改代码）..." });

    const repoPath = gitService.getRepoPath();
    const stagedAttachments = await stageAttachmentsForAgent(job.attachments, repoPath, jobId);
    shouldCleanupWorkspace = true;
    if (stagedAttachments?.length) {
      appendJobEvent(jobId, {
        type: "stage",
        phase: "attachments",
        text: `已准备 ${stagedAttachments.length} 张截图供分析`,
      });
    }

    const planStartedAt = new Date();
    const result = await runAgent(
      repoPath,
      job.prompt,
      job.pageContext,
      (event) => {
        if (event.type === "agent_text" && event.delta) {
          appendJobEvent(jobId, { type: "agent_text", delta: event.delta });
        } else if (event.type === "agent_status" && event.statusText) {
          updateJob(jobId, { message: event.statusText });
          appendJobEvent(jobId, {
            type: "agent_status",
            statusText: event.statusText,
            text: event.statusText,
          });
        } else if (event.type === "agent_tool" && event.toolName) {
          const isWriteTool = /^(Edit|Write|MultiEdit|NotebookEdit|Bash)$/i.test(event.toolName);
          appendJobEvent(jobId, {
            type: "agent_tool",
            toolAction: event.toolAction ?? "start",
            toolName: event.toolName,
            toolDetail: event.toolDetail,
            text: isWriteTool
              ? `⚠ 禁止在 Plan 中使用 ${event.toolName}`
              : event.toolAction === "done"
                ? `✓ ${event.toolName}`
                : `▶ ${event.toolName}${event.toolDetail ? `: ${event.toolDetail}` : ""}`,
          });
        }
      },
      { mode: "plan", jobId, attachments: stagedAttachments }
    );

    await revertPlanWorkspaceChanges(jobId, "Plan 结束后检测到意外文件改动");
    shouldCleanupWorkspace = false;

    const current = getJob(jobId);
    if (!current || current.status === "cancelled") return;

    const planSummary = resolvePlanSummary(result.summary, repoPath, planStartedAt);

    updateJob(jobId, {
      status: "awaiting_confirm",
      planSummary,
      message: "Plan 完成：请在插件端确认是否执行修改",
    });

    appendJobEvent(jobId, {
      type: "stage",
      phase: "plan_done",
      text: "Plan 完成：请确认是否执行修改",
    });
  } catch (err) {
    if (shouldCleanupWorkspace) {
      await revertPlanWorkspaceChanges(jobId, "Plan 中断后还原工作区");
    }

    const current = getJob(jobId);
    if (current?.status === "cancelled" || err instanceof AgentAbortedError) {
      return;
    }
    throw err;
  }
}

async function runQueuedPlan(jobId: string): Promise<void> {
  try {
    await runPlan(jobId);
  } catch (err) {
    const latest = getJob(jobId);
    if (latest?.status === "cancelled" || err instanceof AgentAbortedError) return;

    updateJob(jobId, { status: "failed", error: String(err), message: "Plan 执行失败" });
    appendJobEvent(jobId, { type: "error", message: String(err), text: "Plan 执行失败" });
  }
}

async function runQuestion(jobId: string): Promise<void> {
  const job = updateJob(jobId, {
    status: "running",
    message: "正在只读分析项目...",
    jobsAhead: undefined,
  });
  if (!job) return;

  const repoPath = gitService.getRepoPath();

  try {
    appendJobEvent(jobId, {
      type: "stage",
      phase: "question",
      text: "问答模式：正在读取和分析项目（不会修改代码）...",
    });

    const stagedAttachments = await stageAttachmentsForAgent(
      job.attachments,
      repoPath,
      jobId
    );
    const result = await runAgent(
      repoPath,
      job.prompt,
      job.pageContext,
      (event) => {
        if (event.type === "agent_text" && event.delta) {
          appendJobEvent(jobId, { type: "agent_text", delta: event.delta });
        } else if (event.type === "agent_status" && event.statusText) {
          updateJob(jobId, { message: event.statusText });
          appendJobEvent(jobId, {
            type: "agent_status",
            statusText: event.statusText,
            text: event.statusText,
          });
        } else if (event.type === "agent_tool" && event.toolName) {
          appendJobEvent(jobId, {
            type: "agent_tool",
            toolAction: event.toolAction ?? "start",
            toolName: event.toolName,
            toolDetail: event.toolDetail,
            text:
              event.toolAction === "done"
                ? `✓ ${event.toolName}`
                : `▶ ${event.toolName}${event.toolDetail ? `: ${event.toolDetail}` : ""}`,
          });
        }
      },
      { mode: "question", jobId, attachments: stagedAttachments }
    );

    const current = getJob(jobId);
    if (!current || current.status === "cancelled") return;

    updateJob(jobId, {
      status: "completed",
      message: result.summary,
    });
    appendJobEvent(jobId, {
      type: "done",
      text: result.summary,
      message: result.summary,
    });
  } catch (err) {
    const current = getJob(jobId);
    if (current?.status === "cancelled" || err instanceof AgentAbortedError) return;

    updateJob(jobId, {
      status: "failed",
      error: String(err),
      message: "项目问答失败",
    });
    appendJobEvent(jobId, {
      type: "error",
      message: String(err),
      text: "项目问答失败",
    });
  } finally {
    await cleanupStagedAttachmentsForAgent(repoPath, jobId).catch(() => {});
  }
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

  jobImagesUpload.array("images", config.UPLOAD_MAX_COUNT)(req, res, (err) => {
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

  const job = createJob({ ...parsed.data, ownerId: getRequestOwnerId(req) });
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

jobsRouter.post("/", handleJobImagesUpload, (req, res) => {
  const created = createJobFromSubmit(req);
  if ("error" in created) {
    res.status(400).json({ error: created.error });
    return;
  }

  const { job, data } = created;
  emitUserSubmitEvents(job.jobId, data);

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
  updateJob(job.jobId, { requiresConfirm: true, status: "planning" });
  emitUserSubmitEvents(job.jobId, data);

  void runQueuedPlan(job.jobId);

  res.status(202).json({
    jobId: job.jobId,
    status: "planning",
    message: "已进入 Plan 分析（不改代码），完成后可确认执行",
    jobsAhead: 0,
  });
});

jobsRouter.post("/:jobId/execute", (req, res) => {
  const jobId = req.params.jobId;
  const job = getAuthorizedJob(req, res);
  if (!job) return;

  if (job.status !== "awaiting_confirm") {
    res.status(400).json({ error: `当前状态不可执行: ${job.status}` });
    return;
  }

  const body = req.body as { planSummary?: unknown } | undefined;
  const planSummary =
    typeof body?.planSummary === "string" ? body.planSummary.trim() : job.planSummary?.trim();
  if (!planSummary) {
    res.status(400).json({ error: "Plan 方案为空，请补充方案内容后再执行" });
    return;
  }

  updateJob(jobId, { status: "pending", message: "已确认执行，正在准备独立工作区...", planSummary });
  appendJobEvent(jobId, { type: "stage", phase: "execute_confirmed", text: "已确认执行，正在准备独立工作区..." });
  void processJob(jobId);

  res.status(202).json({
    jobId,
    status: "pending",
    message: "已确认执行，正在准备独立工作区",
    jobsAhead: 0,
  });
});

jobsRouter.post("/:jobId/cancel", async (req, res) => {
  const jobId = req.params.jobId;
  const job = getAuthorizedJob(req, res);
  if (!job) return;

  if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
    res.status(400).json({ error: `当前状态不可取消: ${job.status}` });
    return;
  }

  if (job.status === "awaiting_merge") {
    res.status(400).json({ error: "当前等待确认合并，请使用放弃合并" });
    return;
  }

  updateJob(jobId, { status: "cancelled", message: "任务已取消" });
  const removedFromQueue = jobQueue.dequeue(jobId);

  if (removedFromQueue) {
    appendJobEvent(jobId, { type: "cancelled", message: "任务已取消", text: "任务已取消" });
    res.json({ ok: true });
    return;
  }

  if (job.status === "planning" || job.status === "running") {
    killAgentForJob(jobId);
  }

  try {
    if (job.branch) {
      await gitService.discardFeatureBranch(job.branch, job.worktreePath);
    } else if (job.status === "planning" || job.status === "running") {
      const currentBranch = job.worktreePath
        ? await gitService.getCurrentBranch(job.worktreePath)
        : await gitService.getCurrentBranch();
      if (currentBranch.startsWith("plugin-fix/")) {
        await gitService.discardFeatureBranch(currentBranch, job.worktreePath);
      } else if (job.worktreePath) {
        const reverted = await gitService.discardUncommittedChanges(job.worktreePath);
        await gitService.removeJobWorktree(job.worktreePath);
        if (reverted.length > 0) {
          appendJobEvent(jobId, {
            type: "stage",
            phase: "plan_cleanup",
            text: `取消时已还原 ${reverted.length} 个文件的意外改动`,
          });
        }
      } else {
        const reverted = await gitService.discardUncommittedChanges();
        await gitService.restoreBaseBranch();
        if (reverted.length > 0) {
          appendJobEvent(jobId, {
            type: "stage",
            phase: "plan_cleanup",
            text: `取消时已还原 ${reverted.length} 个文件的意外改动`,
          });
        }
      }
    }
  } catch (err) {
    console.warn(
      "[AI Runtime] 取消任务时清理 Git 工作区失败:",
      err instanceof Error ? err.message : String(err)
    );
    try {
      await gitService.discardUncommittedChanges(job.worktreePath);
      await gitService.restoreBaseBranch();
    } catch {
      // ignore secondary cleanup errors
    }
  }

  appendJobEvent(jobId, { type: "cancelled", message: "任务已取消", text: "任务已取消" });

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

  const body = req.body as { createMergeRequest?: unknown } | undefined;
  const createMergeRequest = body?.createMergeRequest === true;

  updateJob(jobId, {
    status: "pending",
    message: createMergeRequest ? "已确认提交 Merge Request，等待排队..." : "已确认合并，等待排队...",
  });

  const mergeWorker = async (queuedJobId: string) => {
    if (createMergeRequest) {
      await createJobMergeRequest(queuedJobId);
    } else {
      await confirmJobMerge(queuedJobId);
    }
  };

  const gateJobsAhead = jobQueue.enqueueGateContinuation(jobId, mergeWorker);
  const jobsAhead = gateJobsAhead ?? jobQueue.enqueue(jobId, mergeWorker);

  res.status(202).json({
    jobId,
    status: "pending",
    message: jobsAhead > 0
      ? `已加入队列，前面还有 ${jobsAhead} 个任务`
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

  updateJob(jobId, { status: "pending", message: "已确认放弃合并，等待排队..." });
  const discardWorker = async (queuedJobId: string) => {
    try {
      await discardJobMerge(queuedJobId);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      updateJob(queuedJobId, { status: "failed", error, message: "放弃合并失败" });
      appendJobEvent(queuedJobId, { type: "error", message: error, text: `放弃合并失败: ${error}` });
      throw err;
    }
  };
  const gateJobsAhead = jobQueue.enqueueGateContinuation(jobId, discardWorker);
  const jobsAhead = gateJobsAhead ?? jobQueue.enqueue(jobId, discardWorker);
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
    const branches = await gitService.listRemoteBranches();
    const mergedBranches = new Set(
      (job.releaseMerges ?? [])
        .filter((record) => record.status === "completed")
        .map((record) => record.targetBranch)
    );
    res.json({
      branches: branches.filter(
        (branch) =>
          branch !== config.GIT_DEFAULT_BRANCH &&
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
    const { done } = jobQueue.enqueueAndWait(jobId, async (queuedJobId) => {
      await mergeCompletedJobToBranch(queuedJobId, targetBranch);
    });
    await done;
    res.json({ ok: true, job: getJob(jobId) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err), job: getJob(jobId) });
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
    res.json({ ok: true, job: getJob(jobId) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err), job: getJob(jobId) });
  }
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

  for (const event of getJobEvents(jobId)) {
    writeEvent(event);
  }

  if (jobQueue.getJobsAhead(jobId) != null) {
    jobQueue.broadcastQueue(jobId);
  }

  const unsubscribe = subscribeJobEvents(jobId, (event) => {
    writeEvent(event);
    if (event.type === "done" || event.type === "cancelled" || event.type === "error") {
      res.write("event: close\ndata: {}\n\n");
    }
  });

  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, 25_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

jobsRouter.get("/:jobId", (req, res) => {
  const job = getAuthorizedJob(req, res);
  if (!job) return;
  res.json(job);
});

jobsRouter.get("/", (req, res) => {
  res.json({ jobs: listJobs(getRequestOwnerId(req)) });
});
