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

export type TaskMode = "question" | "code" | "test-case";

export interface TestCaseItem {
  caseNumber: number;
  priority: "高" | "中" | "低";
  levelOneModule: string;
  levelTwoModule: string;
  requirementPoint: string;
  testPoint: string;
  preconditions: string;
  steps: string[];
  expectedResult: string;
}

export interface ImplementationAssessment {
  recommendedResult: "已实现" | "部分实现" | "未实现" | "无法判断";
  summary: string;
  evidence: string[];
  gaps: string[];
}

export interface ClarificationQuestion {
  id: string;
  type: "single_choice" | "text";
  question: string;
  reason?: string;
  options?: string[];
  recommendedOption?: string;
  allowOther?: boolean;
  required: boolean;
}

export interface ClarificationAnswer {
  questionId: string;
  question: string;
  value: string;
}

export interface ClarificationExchange {
  questions: ClarificationQuestion[];
  answers: ClarificationAnswer[];
  note?: string;
  answeredAt: string;
}

export interface TestCaseDocument {
  moduleName: string;
  functionDescription: string;
  implementationAssessment?: ImplementationAssessment;
  cases: TestCaseItem[];
}

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
  projectId: string;
  status: JobStatusType;
  prompt?: string;
  agentProvider?: AgentProvider;
  conversationId?: string;
  requiresConfirm?: boolean;
  taskMode?: TaskMode;
  testCaseDocument?: TestCaseDocument;
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
  miniProgramPreviewUrl?: string;
  miniProgramPreviewCreatedAt?: string;
  miniProgramPreviewCommitSha?: string;
  miniProgramUploadVersion?: string;
  miniProgramUploadDescription?: string;
  miniProgramUploadedAt?: string;
  mergeRetryable?: boolean;
  error?: string;
  planSummary?: string;
  clarificationQuestions?: ClarificationQuestion[];
  clarificationHistory?: ClarificationExchange[];
  tapdContext?: TapdContext;
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
  commentCount?: number;
  commentWarning?: string;
  attachedImageCount?: number;
  attachedImageIndexes?: number[];
  status?: string;
  owner?: string;
  fetchedAt: string;
}

export interface SubmitInput {
  prompt: string;
  conversationId: string;
  projectId: string;
  agentProvider?: AgentProvider;
  tapdContext?: TapdContext;
  images?: Blob[];
  imageNames?: string[];
  taskMode?: TaskMode;
}

export type AgentProvider = "claude" | "codex";

export interface ProjectProfile {
  id: string;
  name: string;
  type: "web" | "wechat-mini-program" | "generic";
  defaultBranch: string;
  autoMerge: boolean;
  supportsMiniProgramPreview: boolean;
  packageManager?: "npm" | "pnpm" | "yarn";
}

export interface SubmitResponse {
  jobId: string;
  status: string;
  message: string;
  jobsAhead?: number;
}

export type GitDiffFileStatus = "added" | "modified" | "deleted" | "type_changed";

export interface GitDiffFile {
  path: string;
  status: GitDiffFileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface JobDiff {
  commitSha: string;
  files: GitDiffFile[];
  additions: number;
  deletions: number;
  selectedFile?: string;
  patch?: string;
}

export interface AnalyticsBreakdownItem {
  key: string;
  label: string;
  total: number;
  completed: number;
  failed: number;
  successRate: number;
}

export interface AnalyticsData {
  generatedAt: string;
  days: number;
  projectId?: string;
  availableProjects: Array<{ id: string; name: string }>;
  overview: {
    total: number;
    completed: number;
    failed: number;
    cancelled: number;
    active: number;
    pending: number;
    successRate: number;
    averageDurationMs: number;
  };
  daily: Array<{ date: string; total: number; completed: number; failed: number; cancelled: number }>;
  taskModes: AnalyticsBreakdownItem[];
  projects: AnalyticsBreakdownItem[];
  failures: Array<{ category: string; count: number }>;
  recentAnomalies: Array<{
    jobId: string;
    projectId: string;
    projectName: string;
    status: "failed" | "cancelled";
    category: string;
    message: string;
    time: string;
  }>;
}

export interface CodeChangeAnalytics {
  taskCount: number;
  measuredTaskCount: number;
  fileCount: number;
  additions: number;
  deletions: number;
  attentionTaskCount: number;
  averageFiles: number;
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

export interface NormalizedTapdContent {
  html: string;
  description: string;
  retainedImageIndexes: number[];
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
