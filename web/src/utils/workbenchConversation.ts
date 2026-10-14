import type { JobStatus } from "../types";
import { hasWorkbenchExecutionStarted } from "./workbenchExecution";

export function conversationStatus(job?: JobStatus): string {
  if (!job) return "新对话";
  if (job.workbenchPauseRequested) return "已停止";
  if (job.workbenchReset) return "可继续对话";
  if (job.status === "planning") return "正在分析";
  if (["pending", "running"].includes(job.status)) return job.taskMode === "test-case" ? "正在生成测试用例"
    : hasWorkbenchExecutionStarted(job) ? "正在修改代码" : "正在处理";
  if (job.status === "awaiting_merge" && job.commitSha && job.commitSha !== job.workbenchBaseCommitSha && job.workbenchHasCodeChanges !== false) return "待审查";
  if (job.status === "failed") return "本轮中断";
  if (job.status === "completed") return job.mergedToDefaultAt ? "代码已合并" : job.testCaseDocument ? "测试用例已生成" : "本轮已完成";
  if (job.status === "cancelled") return "已停止";
  if (job.workbenchNeedsInput === true || (job.workbenchNeedsInput === undefined && Boolean(job.clarificationQuestions?.length))) return "等待回复";
  return "可继续对话";
}
