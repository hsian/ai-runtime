export interface PageContext {
  url: string;
  title: string;
  selectedText?: string;
  selectedSelector?: string;
  viewport: { width: number; height: number };
}

export type TapdItemType = "story" | "task" | "bug";

export interface TapdContext {
  workspaceId: string;
  itemType: TapdItemType;
  itemId: string;
  /** 兼容旧版本保存的需求上下文 */
  storyId?: string;
  url: string;
  title: string;
  description: string;
  /** 仅保存在扩展端，用于提取描述配图；提交任务时会移除 */
  sourceHtml?: string;
  /** 描述中按 HTML 顺序出现的图片数量 */
  imageCount?: number;
  /** 用户在当前会话中手动排除的原始配图编号 */
  excludedImageIndexes?: number[];
  /** 当前任务实际随请求上传的 TAPD 配图数量 */
  attachedImageCount?: number;
  /** 当前任务实际随请求上传的原始配图编号 */
  attachedImageIndexes?: number[];
  status?: string;
  owner?: string;
  fetchedAt: string;
  transportMode?: "structured" | "legacy";
}

export interface SubmitRequest {
  prompt: string;
  pageContext?: PageContext;
  tapdContext?: TapdContext;
  submittedBy?: string;
  conversationId?: string;
  images?: Blob[];
  imageNames?: string[];
}

export interface SubmitResponse {
  jobId: string;
  status: string;
  message: string;
  jobsAhead?: number;
  mergeRequestUrl?: string;
}

export type JobStatusType =
  | "planning"
  | "awaiting_confirm"
  | "awaiting_input"
  | "awaiting_merge"
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface JobStatus {
  jobId: string;
  status: JobStatusType;
  prompt?: string;
  conversationId?: string;
  requiresConfirm?: boolean;
  message?: string;
  jobsAhead?: number;
  branch?: string;
  sourceBranch?: string;
  sourceCommitSha?: string;
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
  mergeRetryable?: boolean;
  error?: string;
  planSummary?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationContextStats {
  usedJobs: number;
  maxJobs: number;
  usedChars: number;
  maxChars: number;
}

export interface ReleaseMergeRecord {
  targetBranch: string;
  commitSha?: string;
  status: "completed" | "failed";
  message?: string;
  error?: string;
  mergedAt: string;
}

export interface QueueItemSummary {
  jobId: string;
  prompt: string;
  jobsAhead: number;
}

export interface JobEvent {
  id: string;
  jobId: string;
  timestamp: string;
  type:
    | "user"
    | "queue"
    | "stage"
    | "agent_text"
    | "agent_tool"
    | "agent_status"
    | "done"
    | "cancelled"
    | "error";
  text?: string;
  pageUrl?: string;
  phase?: string;
  delta?: string;
  statusText?: string;
  toolAction?: "start" | "done";
  toolName?: string;
  toolDetail?: string;
  jobsAhead?: number;
  running?: QueueItemSummary | null;
  waiting?: QueueItemSummary[];
  branch?: string;
  commitSha?: string;
  mergeRequestUrl?: string;
  previewUrl?: string;
  previewMessage?: string;
  mergeRetryable?: boolean;
  message?: string;
  attachmentCount?: number;
}

export interface StorageConfig {
  serverUrl: string;
  createMergeRequestOnMerge: boolean;
}

export interface CodingTask {
  id: string;
  jobId?: string;
  conversationId?: string;
  title: string;
  pageUrl: string;
  rawContent: string;
  draftPrompt: string;
  createdAt: string;
  updatedAt: string;
}

export interface CodingConversation {
  id: string;
  title: string;
  jobIds: string[];
  tapdContext?: TapdContext;
  /** TAPD 标签是否尚未随本会话消息成功发送 */
  tapdContextPending?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TapdIteration {
  id: string;
  name: string;
  status?: string;
  startdate?: string;
  enddate?: string;
}

export interface TapdWorkspace {
  id: string;
  name?: string;
  pretty_name?: string;
  status?: string;
}

export interface TapdTaskItem {
  id: string;
  name: string;
  description?: string;
  status?: string;
  owner?: string;
  priority_label?: string;
  story_id?: string;
  iteration_id?: string;
  imageCount?: number;
}
