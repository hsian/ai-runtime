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

export type TapdItemType = "story" | "task" | "bug";

export interface TapdContext {
  workspaceId: string;
  itemType?: TapdItemType;
  itemId?: string;
  /** 兼容旧版插件提交的需求上下文 */
  storyId?: string;
  url: string;
  title: string;
  description: string;
  imageCount?: number;
  attachedImageCount?: number;
  attachedImageIndexes?: number[];
  status?: string;
  owner?: string;
  fetchedAt: string;
}

export interface JobRequest {
  prompt: string;
  projectId?: string;
  agentProvider?: "claude" | "codex";
  pageContext?: PageContext;
  tapdContext?: TapdContext;
  submittedBy?: string;
  conversationId?: string;
  ownerId?: string;
  remoteIp?: string;
  attachments?: JobAttachment[];
  taskMode?: TaskMode;
}

export interface ConversationHistoryMessage {
  role: "user" | "assistant";
  content: string;
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
  projectId: string;
  ownerId: string;
  remoteIp?: string;
  status: JobStatus;
  prompt: string;
  agentProvider?: "claude" | "codex";
  pageContext?: PageContext;
  tapdContext?: TapdContext;
  submittedBy?: string;
  conversationId?: string;
  conversationHistory?: ConversationHistoryMessage[];
  attachments?: JobAttachment[];
  taskMode?: TaskMode;
  testCaseDocument?: TestCaseDocument;
  message?: string;
  /** 前面还有多少任务（含正在执行的），0 表示即将/正在处理 */
  jobsAhead?: number;
  /** plan 完成后再执行 */
  requiresConfirm?: boolean;
  /** plan 总结（用于展示和回溯） */
  planSummary?: string;
  /** Plan 阶段等待产品/测试人员补充的业务问题 */
  clarificationQuestions?: ClarificationQuestion[];
  /** 当前任务内已经完成的澄清记录 */
  clarificationHistory?: ClarificationExchange[];
  /** AI 执行完成后的实际修改总结，用于生成 commit/merge 描述 */
  implementationSummary?: string;
  /** 本次改动所在的 feature 分支，完成后仍用于发版分支合并 */
  sourceBranch?: string;
  /** 本次任务实际产生的提交，用于发版分支 cherry-pick，避免带入 test 上其他提交 */
  sourceCommitSha?: string;
  /** 本次任务独立 Git worktree 路径 */
  worktreePath?: string;
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
  miniProgramPreviewUrl?: string;
  miniProgramPreviewCreatedAt?: string;
  miniProgramPreviewCommitSha?: string;
  miniProgramUploadVersion?: string;
  miniProgramUploadDescription?: string;
  miniProgramUploadedAt?: string;
  /** Git 远程暂时不可用，代码已保留，可仅重试合并 */
  mergeRetryable?: boolean;
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
