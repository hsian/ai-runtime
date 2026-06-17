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
}

export type JobStatusType =
  | "planning"
  | "awaiting_confirm"
  | "awaiting_input"
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
  error?: string;
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
  type: "user" | "queue" | "stage" | "agent_text" | "agent_tool" | "done" | "cancelled" | "error";
  text?: string;
  pageUrl?: string;
  phase?: string;
  delta?: string;
  toolAction?: "start" | "done";
  toolName?: string;
  toolDetail?: string;
  jobsAhead?: number;
  running?: QueueItemSummary | null;
  waiting?: QueueItemSummary[];
  branch?: string;
  commitSha?: string;
  message?: string;
  attachmentCount?: number;
}

export interface StorageConfig {
  serverUrl: string;
}

export interface TapdRequirement {
  url: string;
  title: string;
  contentText: string;
  extractedAt: string;
}

export interface RequirementTask {
  id: string;
  title: string;
  tapdUrl: string;
  rawContent: string;
  draftPrompt: string;
  createdAt: string;
  updatedAt: string;
}

export interface AnalyzeRequirementRequest {
  title: string;
  tapdUrl: string;
  rawContent: string;
}

export interface AnalyzeRequirementResponse {
  draftPrompt: string;
}
