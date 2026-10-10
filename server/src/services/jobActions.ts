import { getJob, updateJob } from "./jobStore.js";
import { appendJobEvent } from "./jobEvents.js";
import { runAgent, killAgentForJob, AgentAbortedError } from "./agent/index.js";
import type { AgentProvider } from "./agent/index.js";
import { config } from "../config.js";
import { getProject } from "./projectRegistry.js";
import { getProjectGitService } from "./projectRuntime.js";
import { stageAttachmentsForAgent, cleanupStagedAttachmentsForAgent } from "./uploadService.js";
import { resolvePlanSummary } from "./agent/planSummaryResolver.js";
import { parsePlanResult, PLAN_RESULT_JSON_SCHEMA } from "./agent/planResult.js";
import { isNonActionablePlanInput } from "./agent/planInputGuard.js";
import { buildPromptWithTapdContext } from "./tapd/tapdContext.js";
import { withApiDocContext } from "./apiDocs.js";
import { logOperation } from "./operationLog.js";
import { processJob } from "./jobProcessor.js";
import { jobQueue } from "./jobQueue.js";
import type { Job, JobRequest, ClarificationAnswer, JobAttachment } from "../types.js";

const MAX_CLARIFICATION_ROUNDS = 2;
function getJobAgentProvider(job: Pick<JobRequest, "agentProvider">): AgentProvider {
  return job.agentProvider ?? config.AGENT_PROVIDER;
}

export function requireOwnedJob(jobId: string, ownerId: string): Job {
  const job = getJob(jobId);
  if (!job || job.ownerId !== ownerId) throw new Error("任务不存在");
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
      await withApiDocContext(buildPromptWithTapdContext(buildPlanRequest(job), job.tapdContext)),
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
      message: "Plan 完成：请确认是否执行修改",
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

export async function runQueuedPlan(jobId: string): Promise<void> {
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

export function parseClarificationAnswers(
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

export function resumePlannedJob(jobId: string, ownerId: string, rawAnswers: unknown, note = "", addedAttachments: JobAttachment[] = []): void {
  const job = requireOwnedJob(jobId, ownerId);
  if (job.status !== "awaiting_input" || !job.clarificationQuestions?.length) throw new Error("当前任务不需要补充信息");
  const parsed = parseClarificationAnswers(rawAnswers, job);
  if (parsed.error || !parsed.answers) throw new Error(parsed.error ?? "补充答案无效");
  const answers = parsed.answers;
  note = note.trim().slice(0, 5000);
  const attachments = [...(job.attachments ?? []), ...addedAttachments];
  const answeredAt = new Date().toISOString();
  const history = [
    ...(job.clarificationHistory ?? []),
    {
      questions: job.clarificationQuestions,
      answers,
      note: note || undefined,
      answeredAt,
    },
  ];
  const answerText = [
    ...answers.map((answer) => `${answer.question}：${answer.value}`),
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
}

export function executePlannedJob(jobId: string, ownerId: string, body?: { planSummary?: unknown; agentProvider?: unknown }): void {
  const job = requireOwnedJob(jobId, ownerId);
  if (job.status !== "awaiting_confirm") {
    throw new Error(`当前状态不可执行: ${job.status}`);
  }

  const planSummary =
    typeof body?.planSummary === "string" ? body.planSummary.trim() : job.planSummary?.trim();
  if (!planSummary) {
    throw new Error("Plan 方案为空，请补充方案内容后再执行");
  }

  if (body?.agentProvider !== undefined && body.agentProvider !== "claude" && body.agentProvider !== "codex") {
    throw new Error("请选择有效的执行引擎");
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
}

export async function cancelOwnedJob(jobId: string, ownerId: string): Promise<void> {
  const job = requireOwnedJob(jobId, ownerId);
  const gitService = getProjectGitService(job.projectId);

  if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
    throw new Error(`当前状态不可取消: ${job.status}`);
  }

  if (job.status === "awaiting_merge") {
    throw new Error("当前等待确认合并，请使用放弃合并");
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
}
export async function runQuestion(jobId: string, options?: { responseInstructions?: string }): Promise<void> {
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
      await withApiDocContext(buildPromptWithTapdContext(job.prompt
        + (options?.responseInstructions ? `\n\n【回复格式】\n${options.responseInstructions}` : ""), job.tapdContext)),
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
