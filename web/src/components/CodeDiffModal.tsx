import {
  CopyOutlined,
  DownloadOutlined,
  FileOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import { Alert, App as AntApp, Button, Empty, Modal, Spin, Tag, Typography } from "antd";
import { useEffect, useMemo, useState } from "react";

import { api } from "../services/api";
import type { GitDiffFile, JobDiff, JobStatus } from "../types";

const statusLabels: Record<GitDiffFile["status"], string> = {
  added: "新增",
  modified: "修改",
  deleted: "删除",
  type_changed: "类型变更",
};

function attentionReason(path: string): string | undefined {
  const normalized = path.toLowerCase();
  if (/(^|\/)(auth|permission|security|login)(\/|\.|$)|token/.test(normalized)) return "涉及登录或权限";
  if (/(^|\/)(routes?|api)(\/|\.|$)|\/services\/.*api/.test(normalized)) return "涉及公共接口或路由";
  if (/migration|schema|database|\.sql$/.test(normalized)) return "涉及数据库结构或数据";
  if (/(^|\/)(config|router|store|layout)(\/|\.|$)|(^|\/)\.env|package(-lock)?\.json$/.test(normalized)) return "涉及公共配置或基础能力";
  return undefined;
}

function lineClassName(line: string): string {
  if (line.startsWith("@@")) return "is-hunk";
  if (line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("diff ") || line.startsWith("index ")) return "is-meta";
  if (line.startsWith("+")) return "is-added";
  if (line.startsWith("-")) return "is-deleted";
  return "";
}

async function copyText(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    return;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    if (!copied) throw new Error("复制失败");
  }
}

function wrapPatchLines(lines: string[], maxChars = 145): Array<{ text: string; kind: string }> {
  const wrapped: Array<{ text: string; kind: string }> = [];
  for (const line of lines) {
    const kind = lineClassName(line);
    if (line.length <= maxChars) {
      wrapped.push({ text: line || " ", kind });
      continue;
    }
    for (let offset = 0; offset < line.length; offset += maxChars) {
      wrapped.push({ text: line.slice(offset, offset + maxChars), kind });
    }
  }
  return wrapped;
}

async function downloadPatchImages(job: JobStatus, diff: JobDiff, file: GitDiffFile): Promise<number> {
  const headerLines = wrapPatchLines([
    `AI Runtime 代码改动 · Job ${job.jobId}`,
    `需求：${job.prompt || "未命名任务"}`,
    `Commit：${diff.commitSha}`,
    `文件：${file.path}（+${file.additions} / -${file.deletions}）`,
    "",
  ]);
  const patchLines = wrapPatchLines((diff.patch || "无文本差异").split(/\r?\n/));
  const maxLinesPerImage = 220;
  const patchLinesPerImage = maxLinesPerImage - headerLines.length - 1;
  const partCount = Math.max(1, Math.ceil(patchLines.length / patchLinesPerImage));
  const scale = 1.25;
  const logicalWidth = 1600;
  const lineHeight = 24;
  const padding = 32;
  const safeName = file.path.split("/").pop()?.replace(/[^a-zA-Z0-9._-]+/g, "-") || "code-diff";

  for (let part = 0; part < partCount; part += 1) {
    const partLabel = partCount > 1 ? [{ text: `第 ${part + 1}/${partCount} 张`, kind: "is-meta" }] : [];
    const currentLines = [
      ...headerLines,
      ...partLabel,
      ...patchLines.slice(part * patchLinesPerImage, (part + 1) * patchLinesPerImage),
    ];
    const logicalHeight = padding * 2 + currentLines.length * lineHeight;
    const canvas = document.createElement("canvas");
    canvas.width = logicalWidth * scale;
    canvas.height = logicalHeight * scale;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器无法生成图片");
    context.scale(scale, scale);
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, logicalWidth, logicalHeight);
    context.font = '14px Consolas, "Microsoft YaHei", monospace';
    context.textBaseline = "top";

    currentLines.forEach((line, index) => {
      const y = padding + index * lineHeight;
      if (line.kind === "is-added") context.fillStyle = "#eaf8ef";
      else if (line.kind === "is-deleted") context.fillStyle = "#fff0f0";
      else if (line.kind === "is-hunk") context.fillStyle = "#eef3ff";
      else context.fillStyle = "#ffffff";
      context.fillRect(0, y - 2, logicalWidth, lineHeight);
      context.fillStyle = line.kind === "is-added"
        ? "#237544"
        : line.kind === "is-deleted"
          ? "#b42318"
          : line.kind === "is-hunk"
            ? "#315cf4"
            : "#25304a";
      context.fillText(line.text, padding, y, logicalWidth - padding * 2);
    });

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((value) => value ? resolve(value) : reject(new Error("图片生成失败")), "image/png");
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.download = `${safeName}-diff${partCount > 1 ? `-${part + 1}` : ""}.png`;
    link.href = url;
    link.click();
    URL.revokeObjectURL(url);
  }
  return partCount;
}

export function CodeDiffModal(props: {
  job?: JobStatus;
  open: boolean;
  onClose: () => void;
}) {
  const { message } = AntApp.useApp();
  const [summary, setSummary] = useState<JobDiff>();
  const [detail, setDetail] = useState<JobDiff>();
  const [selectedPath, setSelectedPath] = useState<string>();
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [error, setError] = useState<string>();
  const jobId = props.job?.jobId;

  useEffect(() => {
    if (!props.open || !jobId) return;
    let active = true;
    setLoadingSummary(true);
    setSummary(undefined);
    setDetail(undefined);
    setSelectedPath(undefined);
    setError(undefined);
    api.getJobDiff(jobId)
      .then((result) => {
        if (!active) return;
        setSummary(result);
        setSelectedPath(result.files[0]?.path);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "代码改动读取失败");
      })
      .finally(() => {
        if (active) setLoadingSummary(false);
      });
    return () => { active = false; };
  }, [jobId, props.open]);

  useEffect(() => {
    if (!props.open || !jobId || !selectedPath) return;
    let active = true;
    setLoadingDetail(true);
    setDetail(undefined);
    api.getJobDiff(jobId, selectedPath)
      .then((result) => {
        if (active) setDetail(result);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "文件改动读取失败");
      })
      .finally(() => {
        if (active) setLoadingDetail(false);
      });
    return () => { active = false; };
  }, [jobId, props.open, selectedPath]);

  const selectedFile = useMemo(
    () => summary?.files.find((file) => file.path === selectedPath),
    [selectedPath, summary]
  );
  const attentionFiles = useMemo(
    () => summary?.files.filter((file) => attentionReason(file.path)) ?? [],
    [summary]
  );

  const copyCurrentDiff = async () => {
    if (!props.job || !summary || !selectedFile) return;
    const text = [
      `AI Runtime 代码改动 - Job ${props.job.jobId}`,
      `需求：${props.job.prompt || "未命名任务"}`,
      `Commit：${summary.commitSha}`,
      `文件：${selectedFile.path}`,
      `变更：+${selectedFile.additions} / -${selectedFile.deletions}`,
      "",
      detail?.patch || "无文本差异",
    ].join("\n");
    try {
      await copyText(text);
      message.success("当前文件的改动信息已复制");
    } catch {
      message.error("复制失败，请直接使用系统截图");
    }
  };

  const exportCurrentDiff = async () => {
    if (!props.job || !detail || !selectedFile) return;
    try {
      const count = await downloadPatchImages(props.job, detail, selectedFile);
      message.success(count > 1 ? `改动较长，已生成 ${count} 张图片` : "当前文件的改动长图已生成");
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : "长图生成失败");
    }
  };

  return (
    <Modal
      className="code-diff-modal"
      title={
        <div className="code-diff-title">
          <span>本次代码改动</span>
          {summary && <Typography.Text type="secondary">Commit {summary.commitSha.slice(0, 10)}</Typography.Text>}
        </div>
      }
      open={props.open}
      onCancel={props.onClose}
      footer={null}
      width="calc(100vw - 72px)"
      destroyOnHidden
    >
      {loadingSummary ? (
        <div className="code-diff-loading"><Spin tip="正在读取本次代码改动" /></div>
      ) : error && !summary ? (
        <Alert type="error" showIcon message="代码改动读取失败" description={`${error}。该辅助功能异常不会影响任务执行结果。`} />
      ) : summary && summary.files.length > 0 ? (
        <div className="code-diff-content">
          <div className="code-diff-summary">
            <div>
              <strong>{summary.files.length} 个文件</strong>
              <span className="diff-added">+{summary.additions}</span>
              <span className="diff-deleted">−{summary.deletions}</span>
              <Typography.Text type="secondary">仅展示当前任务产生的改动</Typography.Text>
            </div>
            <div>
              <Button icon={<CopyOutlined />} disabled={!detail || !selectedFile} onClick={() => void copyCurrentDiff()}>复制当前文件</Button>
              <Button type="primary" icon={<DownloadOutlined />} disabled={!detail || selectedFile?.binary} onClick={() => void exportCurrentDiff()}>
                生成当前文件长图
              </Button>
            </div>
          </div>
          <div className="code-diff-context">
            <code>Job {props.job?.jobId}</code>
            <Typography.Text ellipsis={{ tooltip: props.job?.prompt }}>{props.job?.prompt || "未命名任务"}</Typography.Text>
          </div>

          {attentionFiles.length > 0 && (
            <Alert
              className="code-diff-attention"
              type="warning"
              showIcon
              icon={<WarningOutlined />}
              message={`有 ${attentionFiles.length} 个文件涉及接口、权限、配置或公共能力，建议截图给研发确认`}
            />
          )}

          <div className="code-diff-layout">
            <aside className="code-diff-files">
              <div className="code-diff-files-heading">变更文件</div>
              {summary.files.map((file) => {
                const reason = attentionReason(file.path);
                const parts = file.path.split("/");
                const name = parts.pop() || file.path;
                return (
                  <button
                    type="button"
                    key={file.path}
                    className={`code-diff-file${file.path === selectedPath ? " is-active" : ""}`}
                    onClick={() => {
                      setError(undefined);
                      setSelectedPath(file.path);
                    }}
                  >
                    <FileOutlined />
                    <span className="code-diff-file-copy">
                      <strong>{name}</strong>
                      <span>{parts.join("/") || "/"}</span>
                      {reason && <span className="code-diff-file-reason"><WarningOutlined /> {reason}</span>}
                    </span>
                    <span className="code-diff-file-stats">
                      <Tag>{statusLabels[file.status]}</Tag>
                      {!file.binary && <small><b>+{file.additions}</b> / <i>−{file.deletions}</i></small>}
                    </span>
                  </button>
                );
              })}
            </aside>

            <section className="code-diff-viewer">
              <div className="code-diff-file-heading">
                <code>{selectedPath}</code>
                {selectedFile?.binary && <Tag>二进制文件</Tag>}
              </div>
              {error && <Alert type="error" showIcon message={error} />}
              {loadingDetail ? (
                <div className="code-diff-loading"><Spin /></div>
              ) : selectedFile?.binary ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="这是二进制文件，无法展示文本 Diff" />
              ) : detail?.patch ? (
                <pre className="code-diff-patch" aria-label={`${selectedPath} 的代码改动`}>
                  {detail.patch.split(/\r?\n/).map((line, index) => (
                    <code className={lineClassName(line)} key={`${index}-${line.slice(0, 24)}`}>{line || " "}</code>
                  ))}
                </pre>
              ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前文件没有可显示的文本差异" />
              )}
            </section>
          </div>
        </div>
      ) : (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前任务没有代码改动" />
      )}
    </Modal>
  );
}
