import type { JobStatus } from "../types";
import { businessProjects, type WorkItem } from "./model";

export function mergeWorkbenchItems(saved: WorkItem[], remoteItems: WorkItem[], jobs: JobStatus[]): WorkItem[] {
  const merged = new Map(saved.filter((item) => item.source === "manual").map((item) => [item.id, item]));
  jobs.filter(job => job.workbenchSession && job.conversationId && !job.tapdTask && !job.tapdContext && !saved.some(item => item.conversationId === job.conversationId)).forEach(job => {
    merged.set(job.jobId, { id: job.jobId, title: job.conversationTitle || job.workbenchMessages?.find(item => item.role === "user")?.text.slice(0, 60) || job.prompt?.split("\n")[0] || "对话", description: job.prompt || "", source: "manual", businessProject: businessProjects.find(name => job.prompt?.includes(`所属业务项目：${name}`)), projectId: job.projectId, conversationId: job.conversationId!, taskMode: job.taskMode || "code", createdAt: job.createdAt });
  });
  remoteItems.forEach((item) => {
    const existing = saved.find((entry) => entry.id === item.id);
    merged.set(item.id, existing ? { ...existing, title: item.title, itemType: item.itemType, tapdStatus: item.tapdStatus, parentTitle: item.parentTitle, parentUrl: item.parentUrl, tapdUrl: item.tapdUrl, backendTasks: item.backendTasks, backendDependencyError: item.backendDependencyError } : item);
  });
  return [...merged.values()];
}

export const findWorkbenchJob = (item: WorkItem, jobs: JobStatus[]) => jobs.filter((job) => (item.conversationId && job.conversationId === item.conversationId && job.projectId === item.projectId)
    || (item.source === "tapd" && item.workspaceId && (item.itemType === "task"
      ? job.tapdTask?.workspaceId === item.workspaceId && job.tapdTask.taskId === item.tapdUrl?.split("/").pop()
      : job.tapdContext?.itemType === "bug" && job.tapdContext.workspaceId === item.workspaceId && job.tapdContext.itemId === item.tapdUrl?.split("/").pop())))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

