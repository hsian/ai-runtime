import { Alert, App as AntApp, Button, Input, Modal, Select, Spin } from "antd";
import { useEffect, useRef, useState } from "react";
import { BugRichTextEditor, type BugEditorImage } from "./BugRichTextEditor";
import { api } from "../services/api";
import type { JobStatus, TapdBugDraft, TapdWorkspace, TapdIteration } from "../types";
import { compressImage } from "../utils/imageCompress";
import { createUniqueId } from "../utils/uniqueId";

function buildBugDescription(draft: TapdBugDraft): string {
  const escapeHtml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;");
  const section = (label: string, value: string) => value.trim()
    ? `<p><strong>${label}：</strong></p><p>${escapeHtml(value.trim()).replace(/\n/g, "<br>")}</p>`
    : "";
  return [
    section("前置条件", draft.preconditions),
    section("操作步骤", draft.steps),
    section("实际结果", draft.actualResult),
    section("预期结果", draft.expectedResult),
    section("证据", draft.evidence),
  ].join("");
}

function bugBodyHasText(html: string): boolean {
  return Boolean(new DOMParser().parseFromString(html, "text/html").body.textContent?.trim());
}

export default function TapdBugDialog({ job, busy, onBusyChange: setBusy, onClose }: {
  job: JobStatus;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  onClose: () => void;
}) {
  const { message, modal } = AntApp.useApp();
  const bugJobId = job.jobId;
  const [bugTitle, setBugTitle] = useState("");
  const [bugBodyHtml, setBugBodyHtml] = useState("");
  const [bugGenerating, setBugGenerating] = useState(false);
  const [bugDraftError, setBugDraftError] = useState("");
  const [bugImages, setBugImages] = useState<BugEditorImage[]>([]);
  const bugImagesRef = useRef<BugEditorImage[]>([]);
  const bugDraftRequestId = useRef(0);
  const [workspaces, setWorkspaces] = useState<TapdWorkspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string>();
  const [iterations, setIterations] = useState<TapdIteration[]>([]);
  const [iterationId, setIterationId] = useState<string>();
  const workspaceRequestId = useRef(0);
  const initialDraft = useRef<ReturnType<typeof api.generateTapdBugDraft> | undefined>(undefined);
  const initialWorkspaces = useRef<ReturnType<typeof api.tapdWorkspaces> | undefined>(undefined);
  useEffect(() => { bugImagesRef.current = bugImages; }, [bugImages]);
  useEffect(() => () => bugImagesRef.current.forEach((image) => URL.revokeObjectURL(image.url)), []);
  const generateBugDraft = async (jobId: string, request = api.generateTapdBugDraft(jobId)) => {
    const requestId = ++bugDraftRequestId.current;
    setBugGenerating(true);
    setBugDraftError("");
    try {
      const { draft } = await request;
      if (requestId === bugDraftRequestId.current) {
        setBugTitle(draft.title);
        setBugBodyHtml(buildBugDescription(draft));
      }
    } catch (error) {
      if (requestId === bugDraftRequestId.current) setBugDraftError(error instanceof Error ? error.message : "生成草稿失败，请手动填写");
    } finally {
      if (requestId === bugDraftRequestId.current) setBugGenerating(false);
    }
  };

  const closeBug = onClose;

  const addBugImages = (filesToAdd: File[]): BugEditorImage[] => {
    const valid = filesToAdd.filter((file) => /^image\/(png|jpeg|webp|gif)$/i.test(file.type) && file.size <= 5 * 1024 * 1024);
    if (valid.length !== filesToAdd.length) message.error("仅支持单张不超过 5MB 的 PNG、JPEG、WebP 或 GIF 图片");
    const available = Math.max(0, 5 - bugImages.length);
    if (valid.length > available) message.warning("最多添加 5 张截图");
    const added = valid.slice(0, available).map((file) => ({ id: createUniqueId(), file, url: URL.createObjectURL(file) }));
    if (added.length) setBugImages((current) => [...current, ...added]);
    return added;
  };

  const changeBugBody = (html: string) => {
    setBugBodyHtml(html);
    const doc = new DOMParser().parseFromString(html, "text/html");
    const ids = new Set(Array.from(doc.querySelectorAll("img[data-bug-image-id]"), (image) => image.getAttribute("data-bug-image-id")));
    setBugImages((current) => current.filter((image) => {
      if (ids.has(image.id)) return true;
      URL.revokeObjectURL(image.url);
      return false;
    }));
  };

  const submitTapdBug = async () => {
    if (busy || !workspaceId || !iterationId) return;
    setBusy(true);
    try {
      const doc = new DOMParser().parseFromString(bugBodyHtml, "text/html");
      const imageIds = new Set(Array.from(doc.querySelectorAll("img[data-bug-image-id]"), (image) => image.getAttribute("data-bug-image-id")));
      doc.querySelectorAll("img[data-bug-image-id]").forEach((image) => image.remove());
      const images = await Promise.all(bugImages.filter((image) => imageIds.has(image.id)).map(async ({ file }) => {
        const compressed = await compressImage(file);
        const name = compressed.type === "image/webp" && compressed !== file
          ? file.name.replace(/\.[^.]+$/, "") + ".webp"
          : file.name;
        return new File([compressed], name, { type: compressed.type });
      }));
      const result = await api.createTapdBug({
        title: bugTitle.trim(),
        description: doc.body.innerHTML,
        workspaceId,
        iterationId,
        images,
      });
      closeBug();
      if (result.failedImages.length) {
        modal.warning({
          title: `Bug ${result.bug.id} 已创建，但部分截图未上传`,
          content: `已上传 ${result.uploadedImageCount} 张。失败：${result.failedImages.join("；")}。请到 TAPD 手动补充。`,
        });
      } else {
        message.success(`TAPD Bug 创建成功${images.length ? `，已附 ${images.length} 张截图` : ""}`);
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : "创建 TAPD Bug 失败");
    } finally {
      setBusy(false);
    }
  };

  const changeWorkspace = async (value: string) => {
    const requestId = ++workspaceRequestId.current;
    setWorkspaceId(value);
    setIterationId(undefined);
    setIterations([]);
    try {
      const data = await api.tapdIterations(value);
      if (requestId === workspaceRequestId.current) setIterations(data.iterations);
    } catch (error) {
      if (requestId === workspaceRequestId.current) message.error(error instanceof Error ? error.message : "迭代读取失败");
    }
  };

  useEffect(() => {
    // Reuse initialization requests when StrictMode repeats effect setup.
    initialDraft.current ??= api.generateTapdBugDraft(job.jobId);
    void generateBugDraft(job.jobId, initialDraft.current);
    initialWorkspaces.current ??= api.tapdWorkspaces();
    let active = true;
    void initialWorkspaces.current.then(async data => {
      if (!active) return;
      setWorkspaces(data.workspaces);
      const contextWorkspace = job.tapdContext?.workspaceId;
      const selected = data.workspaces.some(item => item.id === contextWorkspace)
        ? contextWorkspace : data.defaultWorkspaceId || data.workspaces[0]?.id;
      if (selected) await changeWorkspace(selected);
    }).catch(error => {
      if (active) message.error(error instanceof Error ? error.message : "TAPD 配置读取失败");
    });
    return () => { active = false; bugDraftRequestId.current += 1; workspaceRequestId.current += 1; };
  }, [job.jobId]);

  return (
      <Modal
        title="提交 TAPD Bug"
        open
        onCancel={closeBug}
        closable={!busy}
        maskClosable={!busy}
        cancelButtonProps={{ disabled: busy }}
        centered
        width={720}
        className="bug-draft-modal"
        styles={{ body: { maxHeight: "min(56vh, 520px)", overflowY: "auto" } }}
        okText="确认提交 Bug"
        okButtonProps={{ disabled: bugGenerating || !workspaceId || !iterationId || !bugTitle.trim() || !bugBodyHasText(bugBodyHtml) }}
        confirmLoading={busy}
        onOk={() => void submitTapdBug()}
      >
        {bugGenerating ? (
          <div className="bug-draft-loading" role="status" aria-live="polite">
            <Spin size="large" />
            <strong>正在生成缺陷草稿</strong>
            <span>整理任务描述与复现信息中，请稍候</span>
          </div>
        ) : (
          <div className="bug-draft-fields">
            {bugDraftError && <Alert type="warning" showIcon message={bugDraftError} action={<Button size="small" onClick={() => bugJobId && void generateBugDraft(bugJobId)}>重试</Button>} />}
            <div className="bug-draft-projects">
              <label>项目<Select showSearch optionFilterProp="label" value={workspaceId} options={workspaces.map((item) => ({ label: item.name || item.pretty_name || item.id, value: item.id }))} onChange={(value) => void changeWorkspace(value)} placeholder="选择项目" /></label>
              <label>迭代<Select showSearch optionFilterProp="label" value={iterationId} options={iterations.map((item) => ({ label: item.name, value: item.id }))} onChange={setIterationId} placeholder="选择迭代" /></label>
            </div>
            <label>标题<Input value={bugTitle} maxLength={200} onChange={(event) => setBugTitle(event.target.value)} placeholder="模块与异常现象" /></label>
            <div className="bug-body-heading"><span>正文</span>{bugImages.length > 0 && <span>{bugImages.length}/5 张截图</span>}</div>
            <BugRichTextEditor initialHtml={bugBodyHtml} onChange={changeBugBody} onAddImages={addBugImages} />
          </div>
        )}
      </Modal>
  );
}
