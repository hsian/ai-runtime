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
import { processJob } from "../services/jobProcessor.js";
import { appendJobEvent, deleteJobEvents, getJobEvents, subscribeJobEvents } from "../services/jobEvents.js";
import { runAgent, killAgentForJob, AgentAbortedError } from "../services/agent/index.js";
import { config } from "../config.js";
import {
  cleanupStagedAttachmentsForAgent,
  deleteJobAttachments,
  finalizeJobAttachments,
  jobImagesUpload,
  multerErrorMessage,
  stageAttachmentsForAgent,
} from "../services/uploadService.js";
import { isMultipartSubmit, parseJobSubmitBody } from "../middleware/parseJobSubmit.js";
import { confirmJobMerge, createJobMergeRequest, discardJobMerge, mergeCompletedJobToBranch, revertCompletedJobFromDefaultBranch } from "../services/jobMergeService.js";
import type { ClarificationAnswer, Job, JobRequest } from "../types.js";
import type { AgentProvider } from "../services/agent/index.js";
import { resolvePlanSummary } from "../services/agent/planSummaryResolver.js";
import { parsePlanResult, PLAN_RESULT_JSON_SCHEMA } from "../services/agent/planResult.js";
import { isNonActionablePlanInput } from "../services/agent/planInputGuard.js";
import { buildPromptWithTapdContext } from "../services/tapd/tapdContext.js";
import { logOperation } from "../services/operationLog.js";
import { getClientIdentity } from "../services/clientIdentity.js";
import { getProject } from "../services/projectRegistry.js";
import { getProjectGitService } from "../services/projectRuntime.js";
import { deleteMiniProgramPreview, generateMiniProgramPreview, getMiniProgramPreviewPath, uploadMiniProgramCode } from "../services/miniProgramPreviewService.js";
import { existsSync } from "fs";

const MAX_CLARIFICATION_ROUNDS = 2;

function getRequestOwnerId(req: import("express").Request): string {
  return getClientIdentity(req).ownerId;
}

function getJobAgentProvider(job: Pick<JobRequest, "agentProvider">): AgentProvider {
  return job.agentProvider ?? config.AGENT_PROVIDER;
}

function toPublicJob(job: NonNullable<ReturnType<typeof getJob>>) {
  const {
    attachments,
    conversationHistory: _conversationHistory,
    ownerId: _ownerId,
    remoteIp: _remoteIp,
    previewHost: _previewHost,
    worktreePath: _worktreePath,
    ...publicJob
  } = job;
  return {
    ...publicJob,
    attachments: attachments?.map((attachment, index) => ({
      index,
      name: attachment.name,
      mime: attachment.mime,
      sizeBytes: attachment.sizeBytes,
      url: `/api/jobs/${encodeURIComponent(job.jobId)}/attachments/${index}`,
    })),
  };
}

function getPublicJob(jobId: string) {
  const job = getJob(jobId);
  return job ? toPublicJob(job) : undefined;
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
  const gitService = getProjectGitService(job?.projectId);
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

function buildPlanRequest(job: Job): string {
  const exchanges = job.clarificationHistory ?? [];
  const policy = exchanges.length >= MAX_CLARIFICATION_ROUNDS
    ? `\n\n【澄清限制】\n用户已经回答了 ${exchanges.length} 轮问题。请重新检查全部上下文：信息充分则返回 ready；仍无法正确、安全地形成方案则返回 needs_input，不得猜测。`
    : `\n\n【澄清限制】\n先检查全部可用上下文。只有缺少用户才能决定的信息会使方案无法正确或安全地继续时才提问；每轮最多 2 个问题，当前已澄清 ${exchanges.length}/${MAX_CLARIFICATION_ROUNDS} 轮。`;
  if (exchanges.length === 0) return `${job.prompt}${policy}`;
  const clarificationText = exchanges.map((exchange, index) => {
    const answers = exchange.answers
      .map((answer) => `- ${answer.question}\n  用户回答：${answer.value}`)
      .join("\n");
    const note = exchange.note?.trim() ? `\n- 用户补充说明：${exchange.note.trim()}` : "";
    return `第 ${index + 1} 轮：\n${answers}${note}`;
  }).join("\n\n");
  return `${job.prompt}\n\n【用户对 Plan 澄清问题的回答】\n${clarificationText}${policy}`;
}

function normalizeQuestionText(value: string): string {
  return value.replace(/[\s，。！？、,.!?]/g, "").toLowerCase();
}

async function runPlan(jobId: string): Promise<void> {
  const job = updateJob(jobId, { status: "planning", requiresConfirm: true, jobsAhead: undefined });
  if (!job) return;
  const project = getProject(job.projectId);
  const gitService = getProjectGitService(job.projectId);
  const operationStartedAt = Date.now();
  logOperation({
    action: "plan_generate",
    status: "started",
    jobId,
    ownerId: job.ownerId,
    mode: "plan",
    engine: getJobAgentProvider(job),
    attachmentCount: job.attachments?.length,
  });
  let shouldCleanupWorkspace = false;

  const trimmed = job.prompt.trim();
  if (isNonActionablePlanInput(trimmed) && !(job.clarificationHistory?.length)) {
    updateJob(jobId, {
      status: "awaiting_input",
      planSummary: undefined,
      clarificationQuestions: [{
        id: "change_goal",
        type: "text",
        question: "请说明要修改哪个页面或功能，以及期望改成什么效果。",
        reason: "当前输入没有包含可定位的修改目标。",
        required: true,
      }],
      message: "Plan 需要补充信息：请描述具体改动",
    });
    appendJobEvent(jobId, {
      type: "stage",
      phase: "plan_need_more",
      text: "Plan 需要补充信息：当前描述过短，请补充具体改动后重新提交",
    });
    logOperation({
      action: "plan_generate",
      status: "failed",
      jobId,
      ownerId: job.ownerId,
      mode: "plan",
      engine: getJobAgentProvider(job),
      durationMs: Date.now() - operationStartedAt,
      message: "needs_more_input",
    });
    return;
  }

  try {
    const defaultBranch = project.defaultBranch;
    const pullText = `Plan 模式：正在拉取 ${defaultBranch} 分支最新代码...`;
    updateJob(jobId, { message: pullText });
    appendJobEvent(jobId, { type: "stage", phase: "pull", text: pullText });
    await gitService.prepareBaseBranch();

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

    appendJobEvent(jobId, { type: "stage", phase: "plan", text: "Plan 模式：正在分析改动方案（不创建分支、不改代码）..." });

    const planStartedAt = new Date();
    const result = await runAgent(
      repoPath,
      buildPromptWithTapdContext(buildPlanRequest(job), job.tapdContext),
      job.pageContext,
      (event) => {
        if (event.type === "agent_status" && event.statusText) {
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
      {
        mode: "plan",
        jobId,
        agentProvider: getJobAgentProvider(job),
        attachments: stagedAttachments,
        conversationHistory: job.conversationHistory,
        jsonSchema: PLAN_RESULT_JSON_SCHEMA,
      }
    );

    await revertPlanWorkspaceChanges(jobId, "Plan 结束后检测到意外文件改动");
    shouldCleanupWorkspace = false;

    const current = getJob(jobId);
    if (!current || current.status === "cancelled") return;

    const planResult = parsePlanResult(result.summary);

    const askedQuestions = new Set(
      (job.clarificationHistory ?? []).flatMap((exchange) => exchange.questions)
        .map((question) => normalizeQuestionText(question.question))
    );
    const freshQuestions = planResult.result === "needs_input"
      ? planResult.questions.filter((question) => !askedQuestions.has(normalizeQuestionText(question.question))).slice(0, 2)
      : [];

    if (
      planResult.result === "needs_input"
      && freshQuestions.length > 0
      && (job.clarificationHistory?.length ?? 0) < MAX_CLARIFICATION_ROUNDS
    ) {
      updateJob(jobId, {
        status: "awaiting_input",
        planSummary: undefined,
        clarificationQuestions: freshQuestions,
        message: planResult.summary || "Agent 需要补充业务信息后继续生成方案",
      });
      appendJobEvent(jobId, {
        type: "stage",
        phase: "plan_need_more",
        text: `Agent 需要确认 ${freshQuestions.length} 个问题`,
      });
      logOperation({
        action: "plan_generate",
        status: "success",
        jobId,
        ownerId: job.ownerId,
        mode: "plan",
        engine: getJobAgentProvider(job),
        durationMs: Date.now() - operationStartedAt,
        message: "needs_more_input",
      });
      return;
    }

    if (planResult.result === "needs_input") {
      const limitReached = (job.clarificationHistory?.length ?? 0) >= MAX_CLARIFICATION_ROUNDS;
      const error = limitReached
        ? "两轮补充后仍缺少完成方案所需的信息，为避免猜测已停止本次任务"
        : "Agent 重复提出已经回答过的问题，为避免循环已停止本次任务";
      updateJob(jobId, { status: "failed", error, message: error, clarificationQuestions: undefined });
      appendJobEvent(jobId, { type: "error", phase: "plan_blocked", text: error, message: error });
      logOperation({
        action: "plan_generate",
        status: "failed",
        jobId,
        ownerId: job.ownerId,
        mode: "plan",
        engine: getJobAgentProvider(job),
        durationMs: Date.now() - operationStartedAt,
        message: limitReached ? "clarification_limit_reached" : "repeated_clarification",
      });
      return;
    }

    const planSummary = resolvePlanSummary(planResult.summary, repoPath, planStartedAt);

    updateJob(jobId, {
      status: "awaiting_confirm",
      planSummary,
      clarificationQuestions: undefined,
      message: "Plan 完成：请在插件端确认是否执行修改",
    });

    appendJobEvent(jobId, {
      type: "stage",
      phase: "plan_done",
      text: "Plan 完成：请确认是否执行修改",
    });
    logOperation({
      action: "plan_generate",
      status: "success",
      jobId,
      ownerId: job.ownerId,
      mode: "plan",
      engine: getJobAgentProvider(job),
      durationMs: Date.now() - operationStartedAt,
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
    logOperation({
      action: "plan_generate",
      status: "failed",
      jobId,
      ownerId: latest?.ownerId,
      mode: "plan",
      engine: latest ? getJobAgentProvider(latest) : config.AGENT_PROVIDER,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function runQuestion(jobId: string): Promise<void> {
  const existing = getJob(jobId);
  const project = getProject(existing?.projectId);
  const job = updateJob(jobId, {
    status: "running",
    message: `问答模式：正在拉取 ${project.defaultBranch} 分支最新代码...`,
    jobsAhead: undefined,
  });
  if (!job) return;
  const gitService = getProjectGitService(job.projectId);
  const operationStartedAt = Date.now();
  logOperation({
    action: "question_execute",
    status: "started",
    jobId,
    ownerId: job.ownerId,
    mode: "question",
    engine: getJobAgentProvider(job),
    attachmentCount: job.attachments?.length,
  });

  try {
    const defaultBranch = project.defaultBranch;
    const pullText = `问答模式：正在拉取 ${defaultBranch} 分支最新代码...`;
    appendJobEvent(jobId, { type: "stage", phase: "pull", text: pullText });
    await gitService.prepareBaseBranch();

    const repoPath = gitService.getRepoPath();
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
      buildPromptWithTapdContext(job.prompt, job.tapdContext),
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
      {
        mode: "question",
        jobId,
        agentProvider: getJobAgentProvider(job),
        attachments: stagedAttachments,
        conversationHistory: job.conversationHistory,
      }
    );

    const current = getJob(jobId);
    if (!current || current.status === "cancelled") return;

    updateJob(jobId, {
      status: "completed",
      message: result.summary,
    });
    appendJobEvent(jobId, {
      type: "done",
      phase: "question_done",
      text: result.summary,
      message: result.summary,
    });
    logOperation({
      action: "question_execute",
      status: "success",
      jobId,
      ownerId: job.ownerId,
      mode: "question",
      engine: getJobAgentProvider(job),
      durationMs: Date.now() - operationStartedAt,
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
    logOperation({
      action: "question_execute",
      status: "failed",
      jobId,
      ownerId: job.ownerId,
      mode: "question",
      engine: getJobAgentProvider(job),
      durationMs: Date.now() - operationStartedAt,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    const repoPath = gitService.getRepoPath();
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

function parseClarificationAnswers(
  raw: unknown,
  job: Job
): { answers?: ClarificationAnswer[]; error?: string } {
  let value = raw;
  if (typeof raw === "string") {
    try { value = JSON.parse(raw); }
    catch { return { error: "补充答案格式无效" }; }
  }
  if (!Array.isArray(value)) return { error: "请回答 Agent 提出的问题" };

  const submitted = new Map<string, string>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const questionId = String((item as { questionId?: unknown }).questionId ?? "").trim();
    const answer = String((item as { value?: unknown }).value ?? "").trim();
    if (questionId && answer) submitted.set(questionId, answer.slice(0, 5_000));
  }

  const questions = job.clarificationQuestions ?? [];
  const missing = questions.find((question) => question.required && !submitted.get(question.id));
  if (missing) return { error: `请回答：${missing.question}` };
  const invalidChoice = questions.find((question) => {
    const answer = submitted.get(question.id);
    return question.type === "single_choice"
      && Boolean(answer)
      && question.allowOther === false
      && !(question.options ?? []).includes(answer!);
  });
  if (invalidChoice) return { error: `请选择有效答案：${invalidChoice.question}` };

  return {
    answers: questions
      .filter((question) => submitted.has(question.id))
      .map((question) => ({
        questionId: question.id,
        question: question.question,
        value: submitted.get(question.id)!,
      })),
  };
}

export const jobsRouter = Router();

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
  const attachments = [...(job.attachments ?? []), ...addedAttachments];
  const answeredAt = new Date().toISOString();
  const history = [
    ...(job.clarificationHistory ?? []),
    {
      questions: job.clarificationQuestions,
      answers: parsed.answers,
      note: note || undefined,
      answeredAt,
    },
  ];
  const answerText = [
    ...parsed.answers.map((answer) => `${answer.question}：${answer.value}`),
    note ? `补充说明：${note}` : "",
  ].filter(Boolean).join("\n");

  updateJob(jobId, {
    status: "planning",
    message: "已收到补充信息，正在继续生成修改方案...",
    clarificationQuestions: undefined,
    clarificationHistory: history,
    attachments,
  });
  appendJobEvent(jobId, {
    type: "user",
    text: answerText || "已补充信息",
    attachmentCount: addedAttachments.length || undefined,
  });
  appendJobEvent(jobId, {
    type: "stage",
    phase: "plan_resume",
    text: "已收到补充信息，正在继续分析修改方案",
  });
  logOperation({
    action: "plan_clarify",
    status: "success",
    jobId,
    ownerId: job.ownerId,
    mode: "plan",
    engine: getJobAgentProvider(job),
    attachmentCount: addedAttachments.length || undefined,
  });
  void runQueuedPlan(jobId);

  res.status(202).json({
    jobId,
    status: "planning",
    message: "已收到补充信息，正在继续生成修改方案",
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

  const body = req.body as { planSummary?: unknown; agentProvider?: unknown } | undefined;
  const planSummary =
    typeof body?.planSummary === "string" ? body.planSummary.trim() : job.planSummary?.trim();
  if (!planSummary) {
    res.status(400).json({ error: "Plan 方案为空，请补充方案内容后再执行" });
    return;
  }

  if (body?.agentProvider !== undefined && body.agentProvider !== "claude" && body.agentProvider !== "codex") {
    res.status(400).json({ error: "请选择有效的执行引擎" });
    return;
  }
  const agentProvider = body?.agentProvider === "claude" || body?.agentProvider === "codex"
    ? body.agentProvider
    : getJobAgentProvider(job);

  updateJob(jobId, { status: "pending", message: "已确认执行，正在准备独立工作区...", planSummary, agentProvider });
  appendJobEvent(jobId, { type: "stage", phase: "execute_confirmed", text: "已确认执行，正在准备独立工作区..." });
  logOperation({
    action: "plan_confirm",
    status: "success",
    jobId,
    ownerId: job.ownerId,
    mode: "execute",
    engine: agentProvider,
  });
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
  const gitService = getProjectGitService(job.projectId);

  if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
    res.status(400).json({ error: `当前状态不可取消: ${job.status}` });
    return;
  }

  if (job.status === "awaiting_merge") {
    res.status(400).json({ error: "当前等待确认合并，请使用放弃合并" });
    return;
  }

  updateJob(jobId, { status: "cancelled", message: "任务已取消" });
  logOperation({
    action: "job_cancel",
    status: "cancelled",
    jobId,
    ownerId: job.ownerId,
    mode: job.taskMode === "test-case"
      ? "test-case"
      : job.requiresConfirm
        ? (job.status === "planning" ? "plan" : "execute")
        : "question",
    message: `cancelled_from:${job.status}`,
  });
  const removedFromQueue = jobQueue.dequeue(jobId);

  if (removedFromQueue) {
    appendJobEvent(jobId, { type: "cancelled", message: "任务已取消", text: "任务已取消" });
    res.json({ ok: true });
    return;
  }

  if (job.status === "planning" || job.status === "running") {
    killAgentForJob(jobId);
  }

  if (job.status === "running" && !job.requiresConfirm) {
    await cleanupStagedAttachmentsForAgent(gitService.getRepoPath(), jobId).catch(() => {});
    appendJobEvent(jobId, {
      type: "cancelled",
      message: "任务已取消",
      text: "任务已取消",
    });
    res.json({ ok: true });
    return;
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

jobsRouter.delete("/conversation/:conversationId", async (req, res) => {
  const ownerId = getRequestOwnerId(req);
  const conversationId = req.params.conversationId;
  const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
  let resolvedProjectId: string;
  try { resolvedProjectId = getProject(projectId).id; }
  catch (err) { res.status(400).json({ error: err instanceof Error ? err.message : "项目无效" }); return; }
  const jobs = listJobs(ownerId).filter(
    (job) => job.projectId === resolvedProjectId && (job.conversationId || job.jobId) === conversationId
  );
  if (jobs.length === 0) {
    res.status(404).json({ error: "任务不存在" });
    return;
  }

  const deletableStatuses = new Set(["completed", "failed", "cancelled", "awaiting_confirm", "awaiting_input"]);
  const blocked = jobs.find((job) => !deletableStatuses.has(job.status));
  if (blocked) {
    const message = blocked.status === "awaiting_merge"
      ? "任务正在等待合并处理，请先合并或放弃合并"
      : "任务仍在执行，请先取消后再删除";
    res.status(409).json({ error: message });
    return;
  }

  for (const job of jobs) {
    const gitService = getProjectGitService(job.projectId);
    await deleteJobAttachments(job.jobId).catch(() => undefined);
    await deleteMiniProgramPreview(job.jobId).catch(() => undefined);
    await cleanupStagedAttachmentsForAgent(gitService.getRepoPath(), job.jobId).catch(() => undefined);
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

jobsRouter.post("/:jobId/merge", (req, res) => {
  const jobId = req.params.jobId;
  const job = getAuthorizedJob(req, res);
  if (!job) return;

  if (job.status !== "awaiting_merge") {
    res.status(400).json({ error: `当前状态不可合并: ${job.status}` });
    return;
  }

  const body = req.body as { createMergeRequest?: unknown } | undefined;
  const retryingMerge = job.mergeRetryable === true;
  const createMergeRequest = !retryingMerge && body?.createMergeRequest === true;

  updateJob(jobId, {
    status: "pending",
    message: retryingMerge
      ? "已请求重试合并，等待排队..."
      : createMergeRequest
        ? "已确认提交 Merge Request，等待排队..."
        : "已确认合并，等待排队...",
    mergeRetryable: false,
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
    const { done } = jobQueue.enqueueAndWait(jobId, async (queuedJobId) => {
      await mergeCompletedJobToBranch(queuedJobId, targetBranch);
    });
    await done;
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

jobsRouter.post("/:jobId/mini-program-preview", async (req, res) => {
  const jobId = req.params.jobId;
  const job = getAuthorizedJob(req, res);
  if (!job) return;
  const project = getProject(job.projectId);
  if (project.type !== "wechat-mini-program" || !project.miniProgram) {
    res.status(400).json({ error: "当前任务不属于小程序项目" });
    return;
  }
  if (job.status !== "completed" || !job.mergedToDefaultBranch || !(job.sourceCommitSha || job.commitSha)) {
    res.status(400).json({ error: "代码合并到默认分支后才能生成体验版二维码" });
    return;
  }
  try {
    appendJobEvent(jobId, { type: "stage", phase: "mini_program_preview", text: "正在通过微信 CI 生成体验版二维码..." });
    let previewCommitSha = "";
    const { done } = jobQueue.enqueueAndWait(jobId, async () => {
      const result = await generateMiniProgramPreview(job.projectId, jobId, job.implementationSummary || job.prompt, job.sourceCommitSha || job.commitSha || jobId);
      previewCommitSha = result.commitSha;
    });
    await done;
    const createdAt = new Date().toISOString();
    const previewUrl = `/api/jobs/${encodeURIComponent(jobId)}/mini-program-preview`;
    updateJob(jobId, { miniProgramPreviewUrl: previewUrl, miniProgramPreviewCreatedAt: createdAt, miniProgramPreviewCommitSha: previewCommitSha });
    appendJobEvent(jobId, { type: "stage", phase: "mini_program_preview_done", text: "体验版二维码已生成" });
    res.json({ ok: true, previewUrl, createdAt, job: getPublicJob(jobId) });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    appendJobEvent(jobId, { type: "error", phase: "mini_program_preview_failed", text: `体验版二维码生成失败：${error}`, message: error });
    res.status(400).json({ error });
  }
});

jobsRouter.post("/:jobId/mini-program-upload", async (req, res) => {
  const jobId = req.params.jobId;
  const job = getAuthorizedJob(req, res);
  if (!job) return;
  const project = getProject(job.projectId);
  if (project.type !== "wechat-mini-program" || !project.miniProgram) {
    res.status(400).json({ error: "当前任务不属于小程序项目" });
    return;
  }
  if (job.status !== "completed" || !job.mergedToDefaultBranch || job.revertedFromDefaultAt) {
    res.status(400).json({ error: "代码合并到默认分支后才能上传小程序代码" });
    return;
  }
  const version = typeof req.body?.version === "string" ? req.body.version.trim() : "";
  const description = typeof req.body?.description === "string" ? req.body.description.trim() : "";
  if (!version || version.length > 64) {
    res.status(400).json({ error: "请填写 1-64 个字符的上传版本号" });
    return;
  }
  try {
    logOperation({ action: "mini_program_upload", status: "started", jobId, ownerId: job.ownerId, targetBranch: project.defaultBranch, message: version });
    appendJobEvent(jobId, { type: "stage", phase: "mini_program_upload", text: `正在上传小程序开发版本 ${version}...` });
    const { done } = jobQueue.enqueueAndWait(jobId, async () => {
      await uploadMiniProgramCode(job.projectId, version, description || job.prompt);
    });
    await done;
    const uploadedAt = new Date().toISOString();
    updateJob(jobId, { miniProgramUploadVersion: version, miniProgramUploadDescription: description || job.prompt, miniProgramUploadedAt: uploadedAt });
    logOperation({ action: "mini_program_upload", status: "success", jobId, ownerId: job.ownerId, targetBranch: project.defaultBranch, message: version });
    appendJobEvent(jobId, { type: "stage", phase: "mini_program_upload_done", text: `小程序开发版本 ${version} 已上传` });
    res.json({ ok: true, uploadedAt, job: getPublicJob(jobId) });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logOperation({ action: "mini_program_upload", status: "failed", jobId, ownerId: job.ownerId, targetBranch: project.defaultBranch, error });
    appendJobEvent(jobId, { type: "error", phase: "mini_program_upload_failed", text: `小程序代码上传失败：${error}`, message: error });
    res.status(400).json({ error });
  }
});

jobsRouter.get("/:jobId/mini-program-preview", (req, res) => {
  const job = getAuthorizedJob(req, res);
  if (!job) return;
  const outputPath = getMiniProgramPreviewPath(job.jobId);
  if (!job.miniProgramPreviewUrl || !existsSync(outputPath)) {
    res.status(404).json({ error: "体验版二维码尚未生成" });
    return;
  }
  res.setHeader("Cache-Control", "private, no-store");
  res.type("png");
  res.sendFile(outputPath);
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

jobsRouter.get("/:jobId/attachments/:index", (req, res) => {
  const job = getAuthorizedJob(req, res);
  if (!job) return;
  const index = Number(req.params.index);
  const attachment = Number.isInteger(index) && index >= 0 ? job.attachments?.[index] : undefined;
  if (!attachment) {
    res.status(404).json({ error: "图片不存在" });
    return;
  }
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(attachment.name)}`);
  res.type(attachment.mime);
  res.sendFile(attachment.path);
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
  res.json(toPublicJob(job));
});

jobsRouter.get("/", (req, res) => {
  res.json({ jobs: listJobs(getRequestOwnerId(req)).map(toPublicJob) });
});
