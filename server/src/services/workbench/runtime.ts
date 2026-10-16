import { randomUUID } from "node:crypto";
import { getJob, updateJob } from "../jobStore.js";
import { appendJobEvent } from "../jobEvents.js";
import { runAgent, AgentAbortedError } from "../agent/index.js";
import { processJob } from "../jobProcessor.js";
import { getProjectGitService } from "../projectRuntime.js";
import { stageAttachmentsForAgent } from "../uploadService.js";
import { buildPromptWithTapdContext } from "../tapd/tapdContext.js";
import { syncWorkbenchTask } from "../tapd/taskStatusSync.js";
import { releaseTaskToBranch } from "../taskOperations.js";
import { getProject } from "../projectRegistry.js";
import { WORKBENCH_REPLY_GUIDANCE } from "../workbenchReplyGuidance.js";
import { runTestCaseJob } from "../testCases/testCaseJobService.js";

import { buildWorkbenchRequest, parseWorkbenchDecision, WORKBENCH_DECISION_SCHEMA } from "./protocol.js";
import type { WorkbenchWorkerDependencies } from "./worker.js";
import { routeWorkbenchConversation } from "./conversationRouting.js";
import { classifyWithAgent } from "../conversationIntent.js";

export const workbenchDependencies: WorkbenchWorkerDependencies = {
  get: getJob, update: updateJob, execute: processJob, testCases: runTestCaseJob,
  route: job => routeWorkbenchConversation(job, input => classifyWithAgent(input, {
    jobId: job.jobId,
    onEvent: event => { if (event.type === "agent_status") appendJobEvent(job.jobId, { ...event, text: event.statusText }); },
  })),
  event: (id, phase, text) => { appendJobEvent(id, { type: "stage", phase, text }); },
  release: async (id, targetBranch) => {
    const job = getJob(id)!;
    const defaultBranch = getProject(job.projectId).defaultBranch;
    if (job.workbenchAnalysisOnly) return "当前为仅分析模式，不会执行分支合并。请先在工作台完成代码修改和 Review。";
    if (!job.mergedToDefaultAt || job.status !== "completed") return `当前修改尚未完成合并。点击“完成”会先合并到默认分支 ${defaultBranch}，不会直接合并到 ${targetBranch}。请先 Review 并完成，再发送“合并本次修改到${targetBranch}分支”，通过发版功能应用本次提交。`;
    if (targetBranch === defaultBranch) return `本次修改已经合并到默认分支 ${defaultBranch}，无需重复合并。`;
    if (job.releaseMerges?.some(record => record.targetBranch === targetBranch && record.status === "completed")) return `本次修改已经合并到 ${targetBranch}，无需重复执行。`;
    await releaseTaskToBranch(id, targetBranch, { fromConversation: true });
    return `已通过发版合并功能，将本次提交应用到 ${targetBranch}。可在任务活动中查看结果。`;
  },
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
};
