import type { Job } from "../../types.js";
import { buildWorkbenchRequest, type WorkbenchDecision } from "./protocol.js";

// These transitions retain historical fields and their update order. They do not
// write to storage, create worktrees or change TAPD state.
function hasReviewableChanges(job: Job): boolean {
  return Boolean(job.commitSha && job.worktreePath && job.workbenchHasCodeChanges !== false
    && job.commitSha !== job.workbenchBaseCommitSha);
}

export const workbenchTransitions = {
  beginAnalysis(job: Job): Partial<Job> {
    return {
      status: "planning", workbenchReset: false,
      workbenchNeedsInput: false, workbenchInputSource: undefined, workbenchQuestion: undefined,
      workbenchExecutionStarted: job.workbenchExecutionStarted ?? Boolean(job.workbenchHasCodeChanges
        || job.workbenchInputSource === "implementation" || (job.commitSha && job.commitSha !== job.workbenchBaseCommitSha)),
      error: undefined, message: "正在读取上下文…",
    };
  },

  beginImplementation(job: Job, plan: string): Partial<Job> {
    return {
      workbenchQuestion: undefined, workbenchReset: false, workbenchNeedsInput: false,
      planSummary: plan, requiresConfirm: true, status: "pending",
      workbenchLatestPrompt: buildWorkbenchRequest(job),
    };
  },

  beginTestCases(job: Job): Partial<Job> {
    return { workbenchNeedsInput: false, workbenchQuestion: undefined, workbenchLatestPrompt: buildWorkbenchRequest(job) };
  },

  finishTestCases(job: Job): Partial<Job> {
    return {
      status: job.mergedToDefaultAt ? "completed" : hasReviewableChanges(job) ? "awaiting_merge" : "awaiting_input",
      message: "测试用例已生成，可以查看或下载，也可以继续对话。",
    };
  },

  reply(job: Job, decision: WorkbenchDecision): Partial<Job> {
    const needsInput = decision.action === "needs_input";
    return {
      workbenchInputSource: needsInput ? "analysis" : undefined,
      workbenchQuestion: needsInput ? decision.message : undefined,
      status: !needsInput && hasReviewableChanges(job) ? "awaiting_merge" : "awaiting_input",
      workbenchNeedsInput: needsInput, message: needsInput ? "等待你的回复" : "可以继续对话",
      clarificationQuestions: undefined,
    };
  },

  interrupt(text: string, inputCount: number): Partial<Job> {
    return { status: "failed", error: text, message: "本轮执行中断，工作区已保留", workbenchProcessedInputs: inputCount };
  },

  pause(): Partial<Job> {
    return { workbenchPauseRequested: true, status: "awaiting_input", message: "已停止，工作区已保留。发送消息可以继续。" };
  },
};
