import { Router } from "express";
import { createJob, getJob, listJobs, updateJob } from "../services/jobStore.js";
import { jobQueue } from "../services/jobQueue.js";
import { appendJobEvent, getJobEvents, subscribeJobEvents } from "../services/jobEvents.js";
import { gitService } from "../services/gitService.js";
import { runAgent, killAgentForJob, AgentAbortedError } from "../services/agent/index.js";
import { config } from "../config.js";
import { finalizeJobAttachments, jobImagesUpload, multerErrorMessage, stageAttachmentsForAgent } from "../services/uploadService.js";
import { isMultipartSubmit, parseJobSubmitBody } from "../middleware/parseJobSubmit.js";
import { confirmJobMerge, discardJobMerge } from "../services/jobMergeService.js";
import type { JobRequest } from "../types.js";

async function revertPlanWorkspaceChanges(jobId: string, reason: string): Promise<void> {
  const reverted = await gitService.discardUncommittedChanges();
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

  appendJobEvent(jobId, { type: "stage", phase: "plan", text: "Plan 模式：正在分析改动方案（不创建分支、不改代码）..." });

  try {
    const repoPath = gitService.getRepoPath();
    const stagedAttachments = await stageAttachmentsForAgent(job.attachments, repoPath, jobId);
    if (stagedAttachments?.length) {
      appendJobEvent(jobId, {
        type: "stage",
        phase: "attachments",
        text: `已准备 ${stagedAttachments.length} 张截图供分析`,
      });
    }

    const result = await runAgent(
      repoPath,
      job.prompt,
      job.pageContext,
      (event) => {
        if (event.type === "agent_text" && event.delta) {
          appendJobEvent(jobId, { type: "agent_text", delta: event.delta });
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
      { permissionMode: "plan", mode: "plan", jobId, attachments: stagedAttachments }
    );

    await revertPlanWorkspaceChanges(jobId, "Plan 结束后检测到意外文件改动");

    const current = getJob(jobId);
    if (!current || current.status === "cancelled") return;

    updateJob(jobId, {
      status: "awaiting_confirm",
      planSummary: result.summary,
      message: "Plan 完成：请在插件端确认是否执行修改",
    });

    appendJobEvent(jobId, {
      type: "stage",
      phase: "plan_done",
      text: "Plan 完成：请确认是否执行修改",
    });
  } catch (err) {
    await revertPlanWorkspaceChanges(jobId, "Plan 中断后还原工作区");

    const current = getJob(jobId);
    if (current?.status === "cancelled" || err instanceof AgentAbortedError) {
      return;
    }
    throw err;
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

  const job = createJob(parsed.data);
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

  const jobsAhead = jobQueue.enqueue(job.jobId);

  const message =
    jobsAhead > 0
      ? `任务已加入队列，前面还有 ${jobsAhead} 个任务`
      : "任务已创建，即将开始处理";

  res.status(202).json({
    jobId: job.jobId,
    status: job.status,
    message,
    jobsAhead,
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

  runPlan(job.jobId).catch((err) => {
    const latest = getJob(job.jobId);
    if (latest?.status === "cancelled" || err instanceof AgentAbortedError) return;

    updateJob(job.jobId, { status: "failed", error: String(err), message: "Plan 执行失败" });
    appendJobEvent(job.jobId, { type: "error", message: String(err), text: "Plan 执行失败" });
  });

  res.status(202).json({
    jobId: job.jobId,
    status: "planning",
    message: "已进入 Plan 分析（不改代码），完成后可确认执行",
  });
});

jobsRouter.post("/:jobId/execute", (req, res) => {
  const jobId = req.params.jobId;
  const job = getJob(jobId);
  if (!job) {
    res.status(404).json({ error: "任务不存在" });
    return;
  }

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

  updateJob(jobId, { status: "pending", message: "已确认执行，等待排队...", planSummary });
  appendJobEvent(jobId, { type: "stage", phase: "execute_confirmed", text: "已确认执行，正在加入队列..." });

  const jobsAhead = jobQueue.enqueue(jobId);
  res.status(202).json({
    jobId,
    status: "pending",
    message: jobsAhead > 0 ? `已加入队列，前面还有 ${jobsAhead} 个任务` : "已加入队列，即将开始处理",
    jobsAhead,
  });
});

jobsRouter.post("/:jobId/cancel", async (req, res) => {
  const jobId = req.params.jobId;
  const job = getJob(jobId);
  if (!job) {
    res.status(404).json({ error: "任务不存在" });
    return;
  }

  if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
    res.status(400).json({ error: `当前状态不可取消: ${job.status}` });
    return;
  }

  if (job.status === "awaiting_merge") {
    res.status(400).json({ error: "当前等待确认合并，请使用放弃合并" });
    return;
  }

  updateJob(jobId, { status: "cancelled", message: "任务已取消" });

  if (job.status === "planning" || job.status === "running") {
    killAgentForJob(jobId);
  }

  if (job.status === "pending") {
    jobQueue.dequeue(jobId);
  }

  const reverted = await gitService.discardUncommittedChanges();

  appendJobEvent(jobId, { type: "cancelled", message: "任务已取消", text: "任务已取消" });

  if (reverted.length > 0) {
    appendJobEvent(jobId, {
      type: "stage",
      phase: "plan_cleanup",
      text: `取消时已还原 ${reverted.length} 个文件的意外改动`,
    });
  }

  res.json({ ok: true });
});

jobsRouter.post("/:jobId/merge", (req, res) => {
  const jobId = req.params.jobId;
  const job = getJob(jobId);
  if (!job) {
    res.status(404).json({ error: "任务不存在" });
    return;
  }

  if (job.status !== "awaiting_merge") {
    res.status(400).json({ error: `当前状态不可合并: ${job.status}` });
    return;
  }

  res.status(202).json({
    jobId,
    status: "running",
    message: "已确认合并，正在处理...",
  });

  confirmJobMerge(jobId).catch((err) => {
    const latest = getJob(jobId);
    if (latest?.status === "failed") return;
    console.error(`[AI Runtime] 合并任务 ${jobId} 失败:`, err);
  });
});

jobsRouter.post("/:jobId/discard-merge", async (req, res) => {
  const jobId = req.params.jobId;
  const job = getJob(jobId);
  if (!job) {
    res.status(404).json({ error: "任务不存在" });
    return;
  }

  if (job.status !== "awaiting_merge") {
    res.status(400).json({ error: `当前状态不可放弃合并: ${job.status}` });
    return;
  }

  try {
    await discardJobMerge(jobId);
    res.json({ ok: true, status: "cancelled" });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

jobsRouter.get("/:jobId/events", (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: "任务不存在" });
    return;
  }

  res.json({ events: getJobEvents(job.jobId) });
});

jobsRouter.get("/:jobId/stream", (req, res) => {
  const jobId = req.params.jobId;
  const job = getJob(jobId);
  if (!job) {
    res.status(404).json({ error: "任务不存在" });
    return;
  }

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

  if (job.status === "pending") {
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
  const job = getJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: "任务不存在" });
    return;
  }
  res.json(job);
});

jobsRouter.get("/", (_req, res) => {
  res.json({ jobs: listJobs() });
});
