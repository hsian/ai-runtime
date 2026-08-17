import {
  BranchesOutlined,
  CloseCircleOutlined,
  CloudUploadOutlined,
  LinkOutlined,
  RollbackOutlined,
  StopOutlined,
} from "@ant-design/icons";
import { Button, Card, Descriptions, Divider, Empty, Space, Tooltip, Typography } from "antd";

import type { JobEvent, JobStatus } from "../types";
import { ExecutionTimeline } from "./ExecutionTimeline";
import { StatusBadge } from "./StatusBadge";

const cancellable = new Set(["planning", "pending", "running"]);

export function TaskDetailPanel(props: {
  job?: JobStatus;
  events: JobEvent[];
  busy: boolean;
  onCancel: () => void;
  onMerge: () => void;
  onDiscard: () => void;
  onRelease: () => void;
  onRevert: () => void;
  onTapdBug: () => void;
}) {
  if (!props.job) {
    return <aside className="detail-panel"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="选择任务后查看详情" /></aside>;
  }
  const job = props.job;

  return (
    <aside className="detail-panel">
      <div className="panel-heading">
        <div><span>任务详情</span><StatusBadge status={job.status} /></div>
        <Typography.Text type="secondary">{new Date(job.createdAt).toLocaleString("zh-CN")}</Typography.Text>
      </div>

      <Card size="small" className="meta-card">
        <Descriptions column={1} size="small" colon={false}>
          <Descriptions.Item label="模式">{job.requiresConfirm ? "代码修改" : "项目问答"}</Descriptions.Item>
          {job.branch && <Descriptions.Item label="当前分支"><code>{job.branch}</code></Descriptions.Item>}
          {job.sourceBranch && <Descriptions.Item label="任务分支"><code>{job.sourceBranch}</code></Descriptions.Item>}
          {job.commitSha && <Descriptions.Item label="Commit"><code>{job.commitSha.slice(0, 10)}</code></Descriptions.Item>}
        </Descriptions>
        {job.previewUrl && <Button icon={<LinkOutlined />} block href={job.previewUrl} target="_blank">打开预览页面</Button>}
      </Card>

      <Divider titlePlacement="start">执行进度</Divider>
      <ExecutionTimeline events={props.events} />

      <div className="detail-actions">
        {cancellable.has(job.status) && <Button danger icon={<StopOutlined />} loading={props.busy} onClick={props.onCancel}>取消任务</Button>}
        {job.status === "awaiting_merge" && (
          <>
            <Button type="primary" icon={<CloudUploadOutlined />} loading={props.busy} onClick={props.onMerge}>确认合并</Button>
            <Button danger icon={<CloseCircleOutlined />} loading={props.busy} onClick={props.onDiscard}>放弃合并</Button>
          </>
        )}
        {job.status === "completed" && !job.revertedFromDefaultAt && (
          <>
            <Button icon={<BranchesOutlined />} loading={props.busy} onClick={props.onRelease}>合并到其他分支</Button>
            {job.mergedToDefaultBranch && (
              <Button danger icon={<RollbackOutlined />} loading={props.busy} onClick={props.onRevert}>撤回默认分支</Button>
            )}
            {job.planSummary && <Button onClick={props.onTapdBug}>提交 TAPD Bug</Button>}
          </>
        )}
      </div>
    </aside>
  );
}
