import { Tag } from "antd";

import type { JobStatusType } from "../types";

const statusMeta: Record<JobStatusType, { label: string; color: string }> = {
  planning: { label: "规划中", color: "processing" },
  awaiting_confirm: { label: "待确认", color: "warning" },
  awaiting_input: { label: "待补充", color: "warning" },
  awaiting_merge: { label: "待合并", color: "gold" },
  pending: { label: "排队中", color: "default" },
  running: { label: "执行中", color: "processing" },
  completed: { label: "已完成", color: "success" },
  failed: { label: "失败", color: "error" },
  cancelled: { label: "已取消", color: "default" },
};

export function StatusBadge({ status }: { status: JobStatusType }) {
  const meta = statusMeta[status];
  return <Tag color={meta.color}>{meta.label}</Tag>;
}
