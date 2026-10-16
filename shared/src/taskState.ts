/** Pure shared domain logic. No Node, database or transport imports: also used by Web. */
export interface TaskStateInput {
  status: string;
  taskMode?: string;
  commitSha?: string;
  branch?: string;
  mergedToDefaultAt?: string;
  testCaseDocument?: unknown;
  hasTestCases?: boolean;
  message?: string;
  clarificationQuestions?: unknown[];
  workbenchReset?: boolean;
  workbenchPauseRequested?: boolean;
  workbenchTurnRunning?: boolean;
  workbenchExecutionStarted?: boolean;
  workbenchInputSource?: string;
  workbenchHasCodeChanges?: boolean;
  workbenchBaseCommitSha?: string;
  workbenchNeedsInput?: boolean;
  tapdSync?: { target: string; state: string };
}

export function hasTaskExecutionStarted(job?: TaskStateInput): boolean {
  if (!job || job.workbenchReset) return false;
  if (job.workbenchExecutionStarted !== undefined) return job.workbenchExecutionStarted;
  return job.workbenchInputSource === "implementation" || job.workbenchHasCodeChanges === true
    || Boolean(job.commitSha && job.commitSha !== job.workbenchBaseCommitSha)
    || (job.status === "running" && job.taskMode !== "test-case");
}

export function getTaskState(job?: TaskStateInput) {
  const executionStarted = hasTaskExecutionStarted(job);
  const reset = Boolean(job?.workbenchReset);
  const paused = Boolean(job?.workbenchPauseRequested);
  const busy = Boolean(job && !paused && ["planning", "pending", "running"].includes(job.status));
  const hasChanges = Boolean(job?.commitSha && job.commitSha !== job.workbenchBaseCommitSha && job.workbenchHasCodeChanges !== false);
  const canReview = Boolean(job && !reset && job.status === "awaiting_merge" && hasChanges);
  const canComplete = Boolean(canReview && !job?.workbenchTurnRunning);
  const needsInput = Boolean(job && !reset && !paused && job.status === "awaiting_input" && (job.workbenchNeedsInput === true
    || (job.workbenchNeedsInput === undefined && (Boolean(job.clarificationQuestions?.length) || /等待.*(?:回复|补充|澄清)/.test(job.message || "")))));
  const syncPending = Boolean(job?.status === "completed" && ["done", "resolved"].includes(job.tapdSync?.target || "") && job.tapdSync?.state !== "synced");
  const boardStatus = !job || reset ? "未开始" : paused ? executionStarted ? "已停止" : "未开始"
    : syncPending ? "待同步" : canReview ? "待审查" : job.status === "completed" ? "已完成"
    : ["awaiting_confirm", "awaiting_merge"].includes(job.status) ? "未开始"
    : ["planning", "pending", "running", "awaiting_input"].includes(job.status) ? executionStarted ? "执行中" : "未开始"
    : executionStarted ? job.status === "failed" ? "执行中断" : "已停止" : "未开始";
  const workbenchStatus = !job || reset ? "未开始" : paused ? executionStarted ? "已停止" : "未开始 · 分析已停止"
    : busy ? executionStarted ? "执行中" : "未开始 · 分析中" : canReview ? "待审查"
    : job.status === "failed" ? executionStarted ? "执行中断" : "未开始 · 分析中断"
    : job.status === "completed" ? syncPending ? "代码已合并 · TAPD 待同步" : "已完成"
    : needsInput ? executionStarted ? "执行中 · 待补充" : "未开始 · 待补充" : executionStarted ? "执行中" : "未开始";
  const conversationStatus = !job ? "新对话" : paused ? "已停止" : reset ? "可继续对话"
    : job.status === "planning" ? "正在分析" : ["pending", "running"].includes(job.status) ? job.taskMode === "test-case" ? "正在生成测试用例" : executionStarted ? "正在修改代码" : "正在处理"
    : canReview ? "待审查" : job.status === "failed" ? "本轮中断" : job.status === "cancelled" ? "已停止"
    : job.status === "completed" ? job.mergedToDefaultAt ? "代码已合并" : job.testCaseDocument || job.hasTestCases ? "测试用例已生成" : "本轮已完成"
    : needsInput ? "等待回复" : "可继续对话";
  const phase = reset || !job ? "idle" : paused ? "paused" : busy ? executionStarted ? "implementation" : "analysis"
    : canReview ? "review" : job.status === "completed" ? "completed" : job.status === "failed" ? "failed" : needsInput ? "waiting_input" : "idle";
  return { phase, executionStarted, busy, hasChanges, canReview, canComplete, needsInput, syncPending, boardStatus, workbenchStatus, conversationStatus };
}

export type TaskState = ReturnType<typeof getTaskState>;
