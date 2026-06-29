export interface PageContext {
  url: string;
  title: string;
  selectedText?: string;
  selectedSelector?: string;
  viewport: { width: number; height: number };
}

export interface SubmitRequest {
  prompt: string;
  pageContext?: PageContext;
  submittedBy?: string;
  images?: Blob[];
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
  message?: string;
  jobsAhead?: number;
  branch?: string;
  commitSha?: string;
  mergeRequestUrl?: string;
  previewUrl?: string;
  previewFilter?: string;
  previewMessage?: string;
  error?: string;
  planSummary?: string;
  createdAt: string;
  updatedAt: string;
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
  message?: string;
  attachmentCount?: number;
}

export interface StorageConfig {
  serverUrl: string;
  createMergeRequestOnMerge: boolean;
  tapdBatchSilentMode: boolean;
}

export interface CodingTask {
  id: string;
  title: string;
  pageUrl: string;
  rawContent: string;
  draftPrompt: string;
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

export type TapdBatchSessionStatus =
  | "idle"
  | "running"
  | "waiting_confirm"
  | "waiting_merge"
  | "waiting_input"
  | "paused"
  | "completed"
  | "cancelled";

export type TapdBatchTaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped";

export interface TapdBatchTask {
  id: string;
  tapdTaskId: string;
  title: string;
  prompt: string;
  sourceHtml?: string;
  imageCount?: number;
  order: number;
  status: TapdBatchTaskStatus;
  jobId?: string;
  error?: string;
  failedPhase?: string;
  completedAt?: string;
}

export interface TapdBatchSession {
  id: string;
  workspaceId: string;
  iterationId: string;
  iterationName: string;
  status: TapdBatchSessionStatus;
  tasks: TapdBatchTask[];
  currentTaskId?: string;
  activeJobId?: string;
  planSummary?: string;
  previewUrl?: string;
  previewMessage?: string;
  pauseReason?: string;
  createdAt: string;
  updatedAt: string;
}
