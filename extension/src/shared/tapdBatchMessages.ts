export const TAPD_BATCH_STATE = "TAPD_BATCH_STATE";
export const TAPD_BATCH_JOB_EVENT = "TAPD_BATCH_JOB_EVENT";
export const TAPD_BATCH_JOB_LOG = "tapdBatchJobLog";

export type TapdBatchCommand =
  | { type: "TAPD_BATCH_GET_STATE" }
  | { type: "TAPD_BATCH_RESUME"; serverUrl?: string }
  | { type: "TAPD_BATCH_START"; serverUrl: string; session: import("./types.js").TapdBatchSession }
  | { type: "TAPD_BATCH_PAUSE" }
  | { type: "TAPD_BATCH_CANCEL" }
  | { type: "TAPD_BATCH_CONFIRM_EXECUTE"; planSummary: string }
  | { type: "TAPD_BATCH_PLAN_REPLY"; reply: string }
  | { type: "TAPD_BATCH_CONFIRM_MERGE" }
  | { type: "TAPD_BATCH_DISCARD_MERGE" }
  | { type: "TAPD_BATCH_SKIP_CURRENT" }
  | { type: "TAPD_BATCH_RETRY_CURRENT" };
