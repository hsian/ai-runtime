export interface PageContext {
  url: string;
  title: string;
  selectedText?: string;
  selectedSelector?: string;
  viewport: { width: number; height: number };
}

export interface JobAttachment {
  name: string;
  path: string;
  mime: string;
  sizeBytes?: number;
}

export interface JobRequest {
  prompt: string;
  pageContext?: PageContext;
  submittedBy?: string;
  attachments?: JobAttachment[];
}

export type JobStatus =
  | "planning"
  | "awaiting_confirm"
  | "awaiting_input"
  | "awaiting_merge"
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface Job {
  jobId: string;
  status: JobStatus;
  prompt: string;
  pageContext?: PageContext;
  submittedBy?: string;
  attachments?: JobAttachment[];
  message?: string;
  /** 前面还有多少任务（含正在执行的），0 表示即将/正在处理 */
  jobsAhead?: number;
  /** plan 完成后再执行 */
  requiresConfirm?: boolean;
  /** plan 总结（用于展示和回溯） */
  planSummary?: string;
  /** 本次改动所在的 feature 分支，完成后仍用于发版分支合并 */
  sourceBranch?: string;
  /** 本次任务实际产生的提交，用于发版分支 cherry-pick，避免带入 test 上其他提交 */
  sourceCommitSha?: string;
  branch?: string;
  commitSha?: string;
  mergeRequestUrl?: string;
  mergedToDefaultBranch?: string;
  mergedToDefaultAt?: string;
  revertedFromDefaultAt?: string;
  revertCommitSha?: string;
  revertError?: string;
  releaseMerges?: ReleaseMergeRecord[];
  previewUrl?: string;
  previewFilter?: string;
  previewMessage?: string;
  previewHost?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReleaseMergeRecord {
  targetBranch: string;
  commitSha?: string;
  status: "completed" | "failed";
  message?: string;
  error?: string;
  mergedAt: string;
}
