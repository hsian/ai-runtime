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

export interface ReleaseMergeRecord {
  targetBranch: string;
  commitSha?: string;
  status: "completed" | "failed";
  message?: string;
  error?: string;
  mergedAt: string;
}

export interface JobStatus {
  jobId: string;
  status: JobStatusType;
  prompt?: string;
  agentProvider?: AgentProvider;
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
  attachments?: JobAttachmentPreview[];
  createdAt: string;
  updatedAt: string;
}

export interface JobAttachmentPreview {
  index: number;
  name: string;
  mime: string;
  sizeBytes?: number;
  url: string;
}

export interface JobEvent {
  id: string;
  jobId: string;
  timestamp: string;
  type: "user" | "queue" | "stage" | "agent_text" | "agent_tool" | "agent_status" | "done" | "cancelled" | "error";
  text?: string;
  phase?: string;
  delta?: string;
  statusText?: string;
  toolAction?: "start" | "done";
  toolName?: string;
  toolDetail?: string;
  branch?: string;
  commitSha?: string;
  previewUrl?: string;
  previewMessage?: string;
  message?: string;
  attachmentCount?: number;
}

export interface TapdContext {
  workspaceId: string;
  itemType: "story" | "task" | "bug";
  itemId: string;
  url: string;
  title: string;
  description: string;
  sourceHtml?: string;
  imageCount?: number;
  attachedImageCount?: number;
  attachedImageIndexes?: number[];
  status?: string;
  owner?: string;
  fetchedAt: string;
}

export interface SubmitInput {
  prompt: string;
  conversationId: string;
  agentProvider?: AgentProvider;
  tapdContext?: TapdContext;
  images?: Blob[];
  imageNames?: string[];
}

export type AgentProvider = "claude" | "codex";

export interface SubmitResponse {
  jobId: string;
  status: string;
  message: string;
  jobsAhead?: number;
}

export interface TapdWorkspace {
  id: string;
  name?: string;
  pretty_name?: string;
}

export interface TapdIteration {
  id: string;
  name: string;
  status?: string;
}

export interface TapdImageOption {
  sourceIndex: number;
  blob: Blob;
  previewUrl: string;
  selected: boolean;
}

export interface OperationLogEntry {
  time: string;
  action: string;
  status: "started" | "success" | "failed" | "cancelled";
  jobId?: string;
  remoteIp?: string;
  mode?: string;
  engine?: string;
  durationMs?: number;
  branch?: string;
  targetBranch?: string;
  commitSha?: string;
  message?: string;
  error?: string;
}
