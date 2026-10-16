import type { JobStatus } from "../types";
import { getTaskState } from "@ai-runtime/shared/task-state";

export function conversationStatus(job?: JobStatus): string {
  return job?.taskState?.conversationStatus || getTaskState(job).conversationStatus;
}
