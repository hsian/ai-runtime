import type { JobStatus, TapdContext, TaskMode } from "../types";

export interface WorkItem {
  id: string;
  title: string;
  description: string;
  source: "manual" | "tapd";
  projectId: string;
  taskMode: TaskMode;
  conversationId: string;
  createdAt: string;
  workspaceId?: string;
  iterationId?: string;
  parentTitle?: string;
  parentUrl?: string;
  tapdStatus?: string;
  tapdUrl?: string;
  tapdContext?: TapdContext;
  itemType?: "task" | "bug";
  businessProject?: string;
  backendTasks?: Array<{ id: string; name: string; owner?: string; status?: string }>;
  backendDependencyError?: string;
}

export const businessProjects = ["村财项目", "产权项目", "支付中台"];
export const monorepoProjectId = "b2b-composite";
export const tapdStatusLabels: Record<string, string> = {
  open: "未开始", progressing: "进行中", done: "已完成",
  new: "新建", in_progress: "接受/处理", resolved: "已解决",
  verified: "已验证", reopened: "重新打开", rejected: "已拒绝", closed: "已关闭",
};
export const tapdStatusLabel = (status?: string) => status ? tapdStatusLabels[status.toLowerCase()] || status : "TAPD 未返回状态";
export type View = "work" | "manual";
export const needsAttention = (job?: JobStatus) => Boolean(job && ["awaiting_input", "awaiting_confirm", "awaiting_merge", "failed"].includes(job.status));
export const isOwner = (owner: string | undefined, name: string) => Boolean(name.trim() && owner?.split(/[;,，；|]/).some((part) => part.trim() === name.trim()));
export const errorText = (error: unknown) => error instanceof Error ? error.message : "读取失败，请重试";

