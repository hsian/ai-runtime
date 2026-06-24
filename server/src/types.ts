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
  branch?: string;
  commitSha?: string;
  mergeRequestUrl?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}
