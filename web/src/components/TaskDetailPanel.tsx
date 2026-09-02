import {
  BranchesOutlined,
  CloseCircleOutlined,
  CloudUploadOutlined,
  LinkOutlined,
  QrcodeOutlined,
  RollbackOutlined,
  StopOutlined,
} from "@ant-design/icons";
import { Button, Card, Descriptions, Divider, Empty, Image, Tag, Typography } from "antd";

import type { JobEvent, JobStatus, ProjectProfile } from "../types";
import { ExecutionTimeline } from "./ExecutionTimeline";
import { StatusBadge } from "./StatusBadge";

const cancellable = new Set(["planning", "pending", "running"]);

export function TaskDetailPanel(props: {
  job?: JobStatus;
  project?: ProjectProfile;
  jobs: JobStatus[];
  events: JobEvent[];
  busy: boolean;
  onCancel: () => void;
  onMerge: () => void;
  onDiscard: () => void;
  onRelease: () => void;
  onRevert: () => void;
  onTapdBug: () => void;
  onMiniProgramPreview: () => void;
  onMiniProgramUpload: () => void;
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
          {props.project && <Descriptions.Item label="项目">{props.project.name}</Descriptions.Item>}
          <Descriptions.Item label="模式">{job.requiresConfirm ? "代码修改" : "项目问答"}</Descriptions.Item>
          {job.branch && <Descriptions.Item label="当前分支"><code>{job.branch}</code></Descriptions.Item>}
          {job.sourceBranch && <Descriptions.Item label="任务分支"><code>{job.sourceBranch}</code></Descriptions.Item>}
          {job.commitSha && <Descriptions.Item label="Commit"><code>{job.commitSha.slice(0, 10)}</code></Descriptions.Item>}
          {job.miniProgramUploadedAt && <Descriptions.Item label="小程序开发版本">{job.miniProgramUploadVersion} · {new Date(job.miniProgramUploadedAt).toLocaleString("zh-CN")}</Descriptions.Item>}
        </Descriptions>
        {job.previewUrl && <Button icon={<LinkOutlined />} block href={job.previewUrl} target="_blank">打开预览页面</Button>}
        {job.miniProgramPreviewUrl && <div className="mini-program-preview"><Image src={`${job.miniProgramPreviewUrl}?v=${encodeURIComponent(job.miniProgramPreviewCreatedAt || "latest")}`} alt="小程序体验版二维码" width={180} /><Typography.Text type="secondary">微信扫码打开体验版</Typography.Text></div>}
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
            {props.project?.supportsMiniProgramPreview && job.mergedToDefaultBranch && <Button type="primary" icon={<QrcodeOutlined />} loading={props.busy} onClick={props.onMiniProgramPreview}>{job.miniProgramPreviewUrl ? "重新生成体验版二维码" : "生成体验版二维码"}</Button>}
            {props.project?.supportsMiniProgramPreview && job.mergedToDefaultBranch && <Button icon={<CloudUploadOutlined />} loading={props.busy} onClick={props.onMiniProgramUpload}>上传代码</Button>}
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
