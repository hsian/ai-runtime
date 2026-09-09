import type { JobStatus, TaskMode } from "../types";

export const taskModeLabels: Record<TaskMode, string> = {
  question: "项目问答",
  code: "功能修改",
  "test-case": "测试用例",
};

export function resolveTaskMode(job: Pick<JobStatus, "taskMode" | "requiresConfirm">): TaskMode {
  return job.taskMode ?? (job.requiresConfirm ? "code" : "question");
}
