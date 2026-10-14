import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getJob, updateJob } from "./jobStore.js";
import { appendJobEvent } from "./jobEvents.js";
import { runAgent, killAgentForJob, AgentAbortedError } from "./agent/index.js";
import { processJob } from "./jobProcessor.js";
import { getProjectGitService } from "./projectRuntime.js";
import { stageAttachmentsForAgent } from "./uploadService.js";
import { buildPromptWithTapdContext } from "./tapd/tapdContext.js";
import { syncWorkbenchTask } from "./tapd/taskStatusSync.js";
import { WORKBENCH_REPLY_GUIDANCE } from "./workbenchReplyGuidance.js";
import { runTestCaseJob } from "./testCases/testCaseJobService.js";
import type { Job, JobAttachment } from "../types.js";

const decisionSchema = z.object({
  action: z.enum(["reply", "needs_input", "implement", "test_cases", "cancel"]),
  message: z.string().min(1).max(20000),
  plan: z.string().max(20000),
});
export const WORKBENCH_DECISION_SCHEMA = {
  type: "object", additionalProperties: false, required: ["action", "message", "plan"],
  properties: {
    action: { type: "string", enum: ["reply", "needs_input", "implement", "test_cases", "cancel"] },
    message: { type: "string" }, plan: { type: "string" },
  },
};
export function parseWorkbenchDecision(output: string) {
  const value = decisionSchema.parse(JSON.parse(output));
  if (value.action === "implement" && !value.plan.trim()) throw new Error("执行计划为空，已停止自动执行");
  return value;
}
type Decision = ReturnType<typeof parseWorkbenchDecision>;
export interface WorkbenchWorkerDependencies {
  get: (id: string) => Job | undefined;
  update: (id: string, patch: Partial<Job>) => Job | undefined;
  analyze: (job: Job) => Promise<Decision>;
  execute: (id: string) => Promise<void>;
  testCases: (id: string) => Promise<void>;
  event: (id: string, phase: string, text: string) => void;
  cancel?: (id: string, reset?: boolean) => Promise<string>;
}

export const isWorkbenchCancellation = (text: string) => /^(?:请)?(?:取消|撤销)(?:这次|本次|当前|这个|本)?(?:任务|执行|任务执行)(?:吧)?[。！!\s]*$/.test(text.trim());
export const isWorkbenchResetRequest = (text: string) => /^(?:请)?(?:(?:取消|撤销)(?:这次|本次|当前|这个|本)?(?:处理|任务|执行|任务执行)?[，,；;\s]*)?(?:将|把|改|让)?(?:这个|当前|本次)?(?:任务|状态)?(?:改为|改成|设为|设置为|回到|退回|恢复到|恢复为)(?:未开始)(?:状态)?[吧。！!\s]*$/.test(text.trim());

/** One actor per job. Messages received during a turn are durably stored and consumed next. */
export function createWorkbenchWorker(deps: WorkbenchWorkerDependencies) {
  const running = new Map<string, Promise<void>>();
  const resumeAfterPause = new Set<string>();
  const pending = (job: Job) => (job.workbenchMessages ?? []).filter(message => message.role === "user").length > (job.workbenchProcessedInputs ?? 0);
  const appendAssistant = (id: string, text: string) => {
    const job = deps.get(id)!;
    deps.update(id, { workbenchMessages: [...(job.workbenchMessages ?? []), { id: randomUUID(), role: "assistant", text, createdAt: new Date().toISOString() }] });
    deps.event(id, "session_reply", text);
  };
  const drive = async (id: string) => {
    while (true) {
      const current = deps.get(id);
      if (!current || current.workbenchPauseRequested || !pending(current)) return;
      const inputCount = (current.workbenchMessages ?? []).filter(message => message.role === "user").length;
      const latestInput = (current.workbenchMessages ?? []).filter(message => message.role === "user").at(-1)?.text || "";
      deps.update(id, { status: "planning", workbenchReset: false, workbenchExecutionStarted: current.workbenchExecutionStarted ?? Boolean(current.workbenchHasCodeChanges || current.workbenchInputSource === "implementation" || (current.commitSha && current.commitSha !== current.workbenchBaseCommitSha)), error: undefined, message: "正在读取上下文…" });
      deps.event(id, "session_turn", "正在读取需求、对话和项目代码");
      try {
        if ((isWorkbenchCancellation(latestInput) || isWorkbenchResetRequest(latestInput)) && deps.cancel) {
          const reply = await deps.cancel(id, isWorkbenchResetRequest(latestInput));
          deps.update(id, { workbenchProcessedInputs: inputCount });
          appendAssistant(id, reply);
          continue;
        }
        if (current.taskMode === "test-case") {
          deps.update(id, { workbenchProcessedInputs: inputCount, workbenchLatestPrompt: buildWorkbenchRequest(current) });
          await deps.testCases(id);
          if (deps.get(id)?.workbenchPauseRequested) return;
          const latest = deps.get(id)!;
          if (latest.status !== "failed") appendAssistant(id, latest.message || "测试用例已生成，可以查看或下载。");
        } else {
          const decision = await deps.analyze(deps.get(id)!);
          if (deps.get(id)?.workbenchPauseRequested) return;
          deps.update(id, { workbenchProcessedInputs: inputCount });
          if (decision.action !== "cancel") appendAssistant(id, decision.message);
          // New steering arrived while analyzing: do not execute an obsolete plan.
          if (pending(deps.get(id)!)) continue;
          if (decision.action === "cancel" && deps.cancel) {
            appendAssistant(id, await deps.cancel(id, isWorkbenchResetRequest(latestInput)));
          } else if (decision.action === "test_cases") {
            const originalMode = current.taskMode;
            deps.update(id, { workbenchNeedsInput: false, workbenchQuestion: undefined, workbenchLatestPrompt: buildWorkbenchRequest(deps.get(id)!) });
            try {
              await deps.testCases(id);
            } finally {
              deps.update(id, { taskMode: originalMode });
            }
            const latest = deps.get(id)!;
            if (latest.workbenchPauseRequested) return;
            if (latest.status !== "failed") {
              const reviewable = latest.commitSha && latest.worktreePath && latest.workbenchHasCodeChanges !== false && latest.commitSha !== latest.workbenchBaseCommitSha;
              const message = "测试用例已生成，可以查看或下载，也可以继续对话。";
              deps.update(id, { status: latest.mergedToDefaultAt ? "completed" : reviewable ? "awaiting_merge" : "awaiting_input", message });
              appendAssistant(id, message);
            }
          } else if (decision.action === "implement" && current.taskMode !== "question" && !current.workbenchAnalysisOnly) {
            deps.update(id, { workbenchQuestion: undefined, workbenchReset: false, workbenchNeedsInput: false, planSummary: decision.plan, requiresConfirm: true, status: "pending", workbenchLatestPrompt: buildWorkbenchRequest(deps.get(id)!) });
            await deps.execute(id);
            const latest = deps.get(id)!;
            if (latest.workbenchPauseRequested) return;
            if (latest.implementationSummary) appendAssistant(id, latest.implementationSummary);
          } else {
            const latest = deps.get(id)!;
            const reviewable = latest.commitSha && latest.worktreePath && latest.workbenchHasCodeChanges !== false && latest.commitSha !== latest.workbenchBaseCommitSha;
            deps.update(id, { workbenchInputSource: decision.action === "needs_input" ? "analysis" : undefined, workbenchQuestion: decision.action === "needs_input" ? decision.message : undefined, status: decision.action !== "needs_input" && reviewable ? "awaiting_merge" : "awaiting_input", workbenchNeedsInput: decision.action === "needs_input", message: decision.action === "needs_input" ? "等待你的回复" : "可以继续对话", clarificationQuestions: undefined });
          }
        }
      } catch (error) {
        const latest = deps.get(id);
        if (latest?.workbenchPauseRequested) return;
        const text = error instanceof Error ? error.message : String(error);
        deps.update(id, { status: "failed", error: text, message: "本轮执行中断，工作区已保留", workbenchProcessedInputs: inputCount });
        deps.event(id, "session_error", text);
      }
      if (!deps.get(id) || !pending(deps.get(id)!)) return;
    }
  };
  const start = (id: string): Promise<void> => {
    const existing = running.get(id);
    if (existing) return existing;
    deps.update(id, { workbenchTurnRunning: true });
    const task = Promise.resolve().then(() => drive(id)).finally(() => {
      running.delete(id);
      deps.update(id, { workbenchTurnRunning: false });
      if (resumeAfterPause.delete(id)) deps.update(id, { workbenchPauseRequested: false });
      const latest = deps.get(id);
      if (latest && !latest.workbenchPauseRequested && pending(latest)) void start(id);
    });
    running.set(id, task);
    return task;
  };
  return { start, isRunning: (id: string) => running.has(id), resumeAfterPause: (id: string) => { resumeAfterPause.add(id); } };
}

export function buildWorkbenchRequest(job: Job): string {
  const legacyAnswers = (job.clarificationHistory ?? []).map(exchange => [...exchange.answers.map(answer => `${answer.question}：${answer.value}`), exchange.note || ""].filter(Boolean).join("\n")).join("\n\n");
  return `${job.prompt}\n\n【已有方案与补充】\n${job.planSummary || ""}\n${legacyAnswers}\n\n【当前任务的持续对话】\n${(job.workbenchMessages ?? []).slice(job.workbenchContextStartIndex || 0).map(message => `${message.role === "user" ? "用户" : "助手"}：${message.text}`).join("\n\n")}\n\n【当前产出】\n${job.implementationSummary || "暂无代码产出"}`;
}
const worker = createWorkbenchWorker({
  get: getJob, update: updateJob, execute: processJob, testCases: runTestCaseJob,
  event: (id, phase, text) => { appendJobEvent(id, { type: "stage", phase, text }); },
  cancel: async (id, reset) => {
    const job = getJob(id)!;
    if (job.mergedToDefaultAt) {
      updateJob(id, { status: "completed", workbenchReset: false, workbenchNeedsInput: false, message: "代码已经合并，本次取消不会撤回已完成任务" });
      return "这个任务的代码已经合并，取消执行不会撤回已合并代码或重置已完成的 TAPD 任务。";
    }
    const git = getProjectGitService(job.projectId);
    let changed = false;
    if (job.worktreePath) {
      changed = await git.hasUncommittedChanges(job.worktreePath);
      if (job.commitSha && job.commitSha !== job.workbenchBaseCommitSha) {
        const diff = await git.getCommitDiff(job.commitSha, undefined, job.workbenchBaseCommitSha);
        changed ||= diff.files.length > 0;
      }
    }
    if (changed && !reset) {
      updateJob(id, { status: job.commitSha ? "awaiting_merge" : "awaiting_input", workbenchPauseRequested: true, workbenchReset: false, workbenchNeedsInput: false, message: "已停止执行，现有代码修改已保留", error: undefined });
      return "已停止这次执行。工作区已有代码修改，我保留了这些修改；可以查看后决定继续处理。";
    }
    if (reset && job.worktreePath) {
      updateJob(id, {
        workbenchArchivedWorktrees: [...(job.workbenchArchivedWorktrees || []), { path: job.worktreePath, branch: job.branch, commitSha: job.commitSha, archivedAt: new Date().toISOString() }],
        workbenchWorkspaceId: randomUUID(), worktreePath: undefined, branch: undefined, sourceBranch: undefined, workbenchBaseCommitSha: undefined,
        workbenchContextStartIndex: job.workbenchMessages?.length || 0, clarificationHistory: undefined,
        previewUrl: undefined, miniProgramPreviewUrl: undefined, testCaseDocument: undefined, workbenchLatestPrompt: undefined,
      });
    }
    if (reset) updateJob(id, { workbenchContextStartIndex: job.workbenchMessages?.length || 0, clarificationHistory: undefined, conversationHistory: undefined });
    updateJob(id, { status: "awaiting_input", workbenchReset: true, workbenchExecutionStarted: false, workbenchNeedsInput: false, workbenchHasCodeChanges: false, workbenchPauseRequested: false, planSummary: undefined, requiresConfirm: false, clarificationQuestions: undefined, commitSha: undefined, sourceCommitSha: undefined, implementationSummary: undefined, message: "本次执行已取消，任务回到未开始", error: undefined });
    if (reset || (job.tapdOriginalTaskStatus === "open" && job.tapdSync?.target === "progressing")) await syncWorkbenchTask(id, "open");
    if (reset) return "已取消本次处理，任务已回到未开始。之前的工作区已保留为备份，不会继续执行或合并；重新开始时会重新分析，并使用新的工作区。";
    return "已取消这次执行。没有实际代码修改，任务已恢复为未开始；重新开始时会重新分析需求。";
  },
  analyze: async (job) => {
    const git = getProjectGitService(job.projectId);
    let repoPath = job.worktreePath;
    if (!repoPath && job.taskMode !== "question") {
      const round = (job.workbenchRound ?? 0) + 1;
      const branch = `ai-runtime/${job.jobId.slice(0, 8)}-${round}`;
      repoPath = await git.createJobWorktree(job.workbenchWorkspaceId || job.jobId, branch);
      updateJob(job.jobId, { worktreePath: repoPath, branch, sourceBranch: branch, workbenchRound: round, commitSha: undefined, sourceCommitSha: undefined, mergedToDefaultAt: undefined, mergedToDefaultBranch: undefined });
      updateJob(job.jobId, { workbenchBaseCommitSha: await git.getHeadCommit(repoPath), workbenchHasCodeChanges: false });
    }
    if (repoPath && !getJob(job.jobId)?.workbenchBaseCommitSha) updateJob(job.jobId, { workbenchBaseCommitSha: await git.getBranchBaseCommit(repoPath) });
    repoPath ??= git.getRepoPath();
    if (getJob(job.jobId)?.workbenchPauseRequested) throw new AgentAbortedError();
    const attachments = await stageAttachmentsForAgent(job.attachments, repoPath, job.jobId);
    const result = await runAgent(repoPath, buildPromptWithTapdContext(buildWorkbenchRequest(job), job.tapdContext), job.pageContext, event => {
      if (event.type === "agent_tool") appendJobEvent(job.jobId, { ...event, text: event.toolDetail });
      if (event.type === "agent_status") {
        updateJob(job.jobId, { message: event.statusText });
        appendJobEvent(job.jobId, { ...event, text: event.statusText });
      }
    }, {
      jobId: job.jobId, mode: "question", agentProvider: job.agentProvider, attachments,
      conversationHistory: job.conversationHistory, jsonSchema: WORKBENCH_DECISION_SCHEMA, apiDocAccess: true,
      systemPrompt: "你是与用户协作的编程助手。当前阶段只读取代码，不修改文件。理解最新一条用户消息，并结合持续对话、需求正文和评论决定下一步。用户要求生成、补充或调整测试用例时用 test_cases，调用专用用例生成能力；仅讨论用例或要求编写自动化测试代码时分别使用 reply 或 implement。回答、解释、讨论用 reply；确实缺少业务决定才用 needs_input，在 message 中自然提出问题，允许多轮回复；用户授权实现且信息足够时用 implement，输出具体 plan，message 简洁说明马上要做什么。不要每轮重复整份需求，不要机械要求确认计划。用户只问问题时不得执行修改；新补充覆盖旧约定。message 使用中文自然语言，不提 JSON 或内部阶段。严格返回指定 JSON 结构。" + WORKBENCH_REPLY_GUIDANCE + (job.workbenchAnalysisOnly ? "本任务当前仅预先分析。即使信息完整也不得返回 implement 或修改代码；需要用户补充时用 needs_input，分析完成用 reply 概述准备情况。" : ""),
      questionChangeInstructions: "你在只读阶段为持续会话决定下一步，按指定结构返回 reply、needs_input、implement、test_cases 或 cancel。用户要求取消/撤销当前任务时返回 cancel，不得反问下一步或执行代码修改。",
    });
    return parseWorkbenchDecision(result.summary);
  },
});

export function assertWorkbenchCanReceive(jobId: string): Job {
  const job = getJob(jobId);
  if (!job) throw new Error("任务不存在");
  if (!job.workbenchSession && ["planning", "running", "pending"].includes(job.status)) throw new Error("原任务仍在执行，请结束后进入持续对话");
  if (job.workbenchSession && !worker.isRunning(jobId) && ["pending", "running"].includes(job.status)) throw new Error("正在处理代码合并，请完成后再发送消息");
  return job;
}
export function receiveWorkbenchMessage(jobId: string, text: string, attachments: JobAttachment[] = []): void {
  const job = assertWorkbenchCanReceive(jobId);
  text = text.trim();
  if (!text || text.length > 20000) throw new Error("消息应为 1–20000 个字符");
  const attachmentIndexes = attachments.length ? attachments.map((_, index) => (job.attachments?.length ?? 0) + index) : !job.workbenchMessages?.length ? (job.attachments ?? []).map((_, index) => index) : [];
  const messages = [...(job.workbenchMessages ?? []), { id: randomUUID(), role: "user" as const, text, createdAt: new Date().toISOString(), attachmentIndexes }];
  if (job.workbenchAnalysisOnly && /^(?:请)?(?:开始|继续)(?:修改|实现|开发|处理)/.test(text)) updateJob(jobId, { workbenchAnalysisOnly: false });
  const cancelling = isWorkbenchCancellation(text) || isWorkbenchResetRequest(text);
  const deferredResume = (job.workbenchPauseRequested || cancelling) && worker.isRunning(jobId);
  updateJob(jobId, { workbenchSession: true, workbenchNeedsInput: false, workbenchInputSource: undefined, workbenchQuestion: undefined, workbenchMessages: messages, workbenchPauseRequested: Boolean(deferredResume), attachments: [...(job.attachments ?? []), ...attachments] });
  if (deferredResume) worker.resumeAfterPause(jobId);
  if (cancelling && worker.isRunning(jobId)) killAgentForJob(jobId);
  appendJobEvent(jobId, { type: "user", text, attachmentCount: attachments.length || undefined });
  void worker.start(jobId);
}
export function pauseWorkbenchSession(jobId: string): void {
  const job = getJob(jobId);
  if (!job?.workbenchSession || !worker.isRunning(jobId)) throw new Error("当前没有正在执行的会话");
  updateJob(jobId, { workbenchPauseRequested: true, status: "awaiting_input", message: "已停止，工作区已保留。发送消息可以继续。" });
  killAgentForJob(jobId);
  appendJobEvent(jobId, { type: "stage", phase: "session_paused", text: "已停止，工作区已保留。发送消息可以继续。" });
}
