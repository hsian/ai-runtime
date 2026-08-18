import {
  BranchesOutlined,
  CloseCircleOutlined,
  CloudUploadOutlined,
  LinkOutlined,
  RollbackOutlined,
  StopOutlined,
} from "@ant-design/icons";
import { Button, Card, Descriptions, Divider, Empty, Tag, Typography } from "antd";

import type { JobEvent, JobStatus } from "../types";
import { ExecutionTimeline } from "./ExecutionTimeline";
import { StatusBadge } from "./StatusBadge";

const cancellable = new Set(["planning", "pending", "running"]);

export function TaskDetailPanel(props: {
  job?: JobStatus;
  jobs: JobStatus[];
  events: JobEvent[];
  busy: boolean;
  onCancel: () => void;
  onMerge: () => void;
  onDiscard: () => void;
  onRelease: () => void;
  onRevert: () => void;
  onTapdBug: () => void;
  onSelectJob: (jobId: string) => void;
  onBatchRelease: (jobIds: string[]) => void;
  onBatchRevert: (jobIds: string[]) => void;
}) {
  if (!props.job) {
    return <aside className="detail-panel"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="选择任务后查看详情" /></aside>;
  }
  const job = props.job;
  const releaseCandidates = props.jobs.filter(
    (item) => item.status === "completed" && !item.revertedFromDefaultAt && Boolean(item.sourceCommitSha || item.commitSha)
  );
  const revertCandidates = props.jobs.filter(
    (item) => item.status === "completed" && !item.revertedFromDefaultAt && Boolean(item.mergedToDefaultBranch && item.commitSha)
  );
  const hasCodeCommit = Boolean(job.sourceCommitSha || job.commitSha);

  return (
    <aside className="detail-panel">
      <div className="panel-heading">
        <div><span>任务详情</span><StatusBadge status={job.status} /></div>
        <Typography.Text type="secondary">{new Date(job.createdAt).toLocaleString("zh-CN")}</Typography.Text>
      </div>

      {props.jobs.length > 1 && (
        <section className="subtask-section">
          <div className="subtask-heading"><span>子任务</span><Tag>{props.jobs.length}</Tag></div>
          <div className="subtask-list">
            {props.jobs.map((item, index) => (
              <button
                type="button"
                key={item.jobId}
                className={`subtask-item${item.jobId === job.jobId ? " is-active" : ""}${item.revertedFromDefaultAt ? " is-reverted" : ""}`}
                onClick={() => props.onSelectJob(item.jobId)}
              >
                <span className="subtask-index">第 {index + 1} 次</span>
                <span className="subtask-title">{item.prompt || "未命名子任务"}</span>
                <span className="subtask-state">{item.revertedFromDefaultAt ? "已撤回" : item.commitSha ? `Commit ${item.commitSha.slice(0, 7)}` : <StatusBadge status={item.status} />}</span>
              </button>
            ))}
          </div>
          {(releaseCandidates.length > 1 || revertCandidates.length > 1) && (
            <div className="subtask-batch-actions">
              {releaseCandidates.length > 1 && (
                <Button size="small" icon={<BranchesOutlined />} loading={props.busy} onClick={() => props.onBatchRelease(releaseCandidates.map((item) => item.jobId))}>
                  顺序合并 {releaseCandidates.length} 个
                </Button>
              )}
              {revertCandidates.length > 1 && (
                <Button size="small" danger icon={<RollbackOutlined />} loading={props.busy} onClick={() => props.onBatchRevert(revertCandidates.map((item) => item.jobId))}>
                  倒序撤回 {revertCandidates.length} 个
                </Button>
              )}
            </div>
          )}
        </section>
      )}

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
        {job.status === "completed" && !job.revertedFromDefaultAt && hasCodeCommit && (
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
