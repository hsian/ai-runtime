import { ArrowDownOutlined, CheckOutlined, CodeOutlined, FileTextOutlined, PaperClipOutlined, SendOutlined, StopOutlined, ToolOutlined } from "@ant-design/icons";
import { Alert, App as AntApp, Button, Image, Input, Modal, Select, Spin, Tag } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ClipboardEvent } from "react";
import { api, openJobStream } from "../services/api";
import type { AgentProvider, JobDiff, JobEvent, JobStatus, TapdContext, TaskMode } from "../types";
import { compressImage } from "../utils/imageCompress";
import { CodeDiffModal } from "./CodeDiffModal";
import { TestCaseResult } from "./TestCaseResult";
import { WorkbenchMessageBody } from "./WorkbenchMessageBody";
import "../styles/workbench-chat.css";

export interface WorkbenchTaskLaunch {
  title?: string;
  businessProject?: string;
  conversationId: string;
  projectId: string;
  prompt: string;
  taskMode: TaskMode;
  tapdContext?: TapdContext;
  tapdTask?: { workspaceId: string; taskId: string };
  jobId?: string;
}
const runningStatuses = ["planning", "pending", "running"];
const canReview = (job?: JobStatus): job is JobStatus & { status: "awaiting_merge" } => Boolean(job?.status === "awaiting_merge" && job.commitSha && job.commitSha !== job.workbenchBaseCommitSha && job.workbenchHasCodeChanges !== false);
const statusText = (job?: JobStatus) => !job || job.workbenchReset ? "未开始" : job.workbenchPauseRequested ? "已停止" : runningStatuses.includes(job.status) ? "执行中" : canReview(job) ? "待审查" : job.status === "failed" ? "执行中断" : job.status === "completed" ? job.tapdSync?.target === "done" && job.tapdSync.state !== "synced" ? "代码已合并 · TAPD 待同步" : "已完成" : job.workbenchNeedsInput === true || (job.workbenchNeedsInput === undefined && (Boolean(job.clarificationQuestions?.length) || /等待.*(?:回复|补充|澄清)/.test(job.message || ""))) ? "执行中 · 待补充" : "未开始";

/** Own state and interaction: deliberately independent from the original Web App. */
export function WorkbenchSession({ task, onChanged }: { task: WorkbenchTaskLaunch; onChanged: () => void }) {
  const { message } = AntApp.useApp();
  const [jobs, setJobs] = useState<JobStatus[]>([]);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<Array<{ name: string; url: string }>>([]);
  const [provider, setProvider] = useState<AgentProvider>("codex");
  const [sending, setSending] = useState(false);
  const [acting, setActing] = useState(false);
  const [panel, setPanel] = useState<"requirement" | "changes" | "activity">("requirement");
  const [diffOpen, setDiffOpen] = useState(false);
  const [diff, setDiff] = useState<JobDiff>();
  const [diffError, setDiffError] = useState("");
  const [diffPath, setDiffPath] = useState<string>();
  const [mergeOpen, setMergeOpen] = useState(false);
  const [newMessages, setNewMessages] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const follow = useRef(true);
  const fetchVersion = useRef(0);
  const mounted = useRef(true);
  const job = jobs.at(-1);
  const notStarted = statusText(job) === "未开始";
  const active = Boolean(job && runningStatuses.includes(job.status) && !job.workbenchPauseRequested);
  const context = task.tapdContext || job?.tapdContext;
  const pendingMessageIds = new Set((job?.workbenchMessages ?? []).filter(item => item.role === "user").slice(job?.workbenchProcessedInputs ?? 0).map(item => item.id));
  const reload = useCallback(async () => {
    const version = ++fetchVersion.current;
    try {
      const related = (await api.listJobs()).filter(item => item.conversationId === task.conversationId && item.projectId === task.projectId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const latest = related.at(-1);
      const loadedEvents = latest ? await api.getEvents(latest.jobId) : [];
      if (!mounted.current || version !== fetchVersion.current) return;
      setJobs(related); setEvents(current => [...loadedEvents, ...current.filter(event => event.jobId === latest?.jobId && !loadedEvents.some(loaded => loaded.id === event.id))]); setError("");
    } catch (cause) {
      if (mounted.current && version === fetchVersion.current) setError(cause instanceof Error ? cause.message : "读取会话失败");
    } finally { if (mounted.current) setLoading(false); }
  }, [task.conversationId, task.projectId]);
  useEffect(() => {
    mounted.current = true;
    void reload();
    const timer = window.setInterval(() => void reload(), 3000);
    return () => { mounted.current = false; fetchVersion.current++; window.clearInterval(timer); };
  }, [reload]);
  useEffect(() => {
    if (!job?.jobId || !active) return;
    let timer: number | undefined;
    const source = openJobStream(job.jobId, event => {
      setEvents(current => current.some(item => item.id === event.id) ? current : [...current, event]);
      if (event.type !== "agent_text") {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => void reload(), 200);
      }
    });
    return () => { source.close(); window.clearTimeout(timer); };
  }, [job?.jobId, active, reload]);
  useEffect(() => {
    const items = files.map(file => ({ name: file.name, url: URL.createObjectURL(file) }));
    setPreviews(items);
    return () => items.forEach(item => URL.revokeObjectURL(item.url));
  }, [files]);
  useEffect(() => {
    setDiff(undefined); setDiffError("");
    if (panel !== "changes" || !job?.commitSha) return;
    let current = true;
    void api.getJobDiff(job.jobId).then(result => { if (current) setDiff(result); }).catch(cause => { if (current) setDiffError(cause instanceof Error ? cause.message : "读取 Diff 失败"); });
    return () => { current = false; };
  }, [job?.jobId, job?.commitSha, panel]);
  const messages = jobs.flatMap(item => item.workbenchMessages?.length ? item.workbenchMessages : [
    { id: `${item.jobId}-user`, role: "user" as const, text: item.prompt || task.title || "开始处理需求", createdAt: item.createdAt, attachmentIndexes: [] },
    ...(item.planSummary ? [{ id: `${item.jobId}-plan`, role: "assistant" as const, text: item.planSummary, createdAt: item.createdAt, attachmentIndexes: [] }] : []),
    ...(item.implementationSummary ? [{ id: `${item.jobId}-result`, role: "assistant" as const, text: item.implementationSummary, createdAt: item.updatedAt, attachmentIndexes: [] }] : []),
  ]);
  const lastBoundary = events.reduce((index, event, position) => event.phase === "session_reply" || event.phase === "session_turn" ? position : index, -1);
  const liveText = events.slice(lastBoundary + 1).filter(event => event.type === "agent_text").map(event => event.delta || "").join("");
  const tools = events.filter(event => event.type === "agent_tool");
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (follow.current) { element.scrollTop = element.scrollHeight; setNewMessages(false); }
    else setNewMessages(true);
  }, [messages.length, messages.at(-1)?.text, liveText, job?.status]);
  const submit = async () => {
    if (sending || loading || (job && !notStarted && !draft.trim())) return;
    setSending(true); setError("");
    const text = draft.trim() || "请开始处理这个需求。";
    let tapdImages: Awaited<ReturnType<typeof api.tapdDescriptionImages>> = [];
    try {
      if (!job && context) tapdImages = await api.tapdDescriptionImages(context);
      const images = await Promise.all([...tapdImages.map(image => image.blob), ...files].map(compressImage));
      const names = [...tapdImages.map((_, index) => `tapd-description-${index + 1}.webp`), ...files.map(file => `${file.name.replace(/\.[^.]+$/, "")}.webp`)];
      if (job) await api.sendWorkbenchMessage(job.jobId, text, images, names);
      else await api.startWorkbench({ prompt: task.prompt, conversationId: task.conversationId, projectId: task.projectId, taskMode: task.taskMode, tapdTask: task.tapdTask, agentProvider: provider, tapdContext: context ? { ...context, attachedImageCount: tapdImages.length } : undefined, images, imageNames: names }, text);
      setDraft(""); setFiles([]); follow.current = true;
      await reload(); onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "发送失败，输入内容已保留"); }
    finally { tapdImages.forEach(image => URL.revokeObjectURL(image.previewUrl)); setSending(false); }
  };
  const perform = async (action: () => Promise<unknown>) => {
    if (acting) return;
    setActing(true);
    try { await action(); await reload(); onChanged(); }
    catch (cause) { message.error(cause instanceof Error ? cause.message : "操作失败"); }
    finally { setActing(false); }
  };
  const addFiles = (incoming: File[]) => setFiles(current => [...current, ...incoming.filter(file => file.type.startsWith("image/"))]);
  const paste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const images = Array.from(event.clipboardData.items).filter(item => item.kind === "file" && item.type.startsWith("image/")).map(item => item.getAsFile()).filter((file): file is File => Boolean(file));
    if (images.length) { event.preventDefault(); addFiles(images); }
  };
  const mergeBusy = Boolean(job?.workbenchSession && active && !job.workbenchTurnRunning);
  return <div className="wb-chat-workspace">
    <section className="wb-chat-main">
      <header className="wb-chat-header"><span>对话 <Tag>{statusText(job)}</Tag></span><span>{task.businessProject}</span></header>
      <div className="wb-chat-scroll" ref={scrollRef} onScroll={() => { const element = scrollRef.current; if (element) follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 70; }}>
        <div className="wb-chat-thread">
          {loading ? <Spin /> : !messages.length ? <div className="wb-chat-welcome"><div className="wb-chat-agent-icon">ai</div><h2>一起完成这个任务</h2><p>需求和评论已放入上下文。开始后，我会检查代码并推进实现；需要你决定的地方，会在这里提问。</p><details className="wb-chat-context"><summary><FileTextOutlined /> {context?.title || task.title || "需求背景"}</summary><p>{context?.description || task.prompt}</p></details><p className="wb-chat-muted">你可以先补充要求，或直接开始处理。</p></div> : messages.map(item => <article className={`wb-chat-message is-${item.role}`} key={item.id}><div className="wb-chat-message-label">{item.role === "user" ? "你" : "ai-runtime"}{pendingMessageIds.has(item.id) && <span className="wb-chat-pending">待接续</span>}</div><WorkbenchMessageBody text={item.text} />{Boolean(item.attachmentIndexes?.length) && <div className="wb-chat-message-images">{item.attachmentIndexes!.map(index => job?.attachments?.[index]).filter(attachment => attachment && !/^tapd-description-\d+\./i.test(attachment.name)).map(attachment => attachment && <Image key={attachment.index} src={attachment.url} alt={attachment.name} />)}</div>}</article>)}
          {context?.commentWarning && <Alert type="warning" showIcon title={context.commentWarning} />}
          {job?.testCaseDocument && <TestCaseResult jobId={job.jobId} document={job.testCaseDocument} />}
          {active && <div className="wb-chat-live" aria-live="polite"><span className="wb-chat-thinking"><i />{job?.message || "正在处理…"}</span>{liveText && <WorkbenchMessageBody text={liveText} />}<details><summary><ToolOutlined /> 查看本轮执行活动</summary>{tools.slice(-12).map(event => <p key={event.id}>{event.toolName} {event.toolDetail}</p>)}</details></div>}
          {canReview(job) && <div className="wb-chat-review"><CheckOutlined /><span>代码已准备好，可以查看 Diff；有需要调整的地方，直接继续对话。</span><Button size="small" onClick={() => { setPanel("changes"); setDiffOpen(true); }}>查看 Diff</Button></div>}
          {job?.status === "failed" && <Alert type="error" showIcon title="本轮执行中断" description={job.error || job.message} />}
          {error && <Alert type="error" showIcon title={error} action={<Button size="small" onClick={() => void reload()}>重试读取</Button>} />}
        </div>
      </div>
      {newMessages && <Button className="wb-chat-new-messages" icon={<ArrowDownOutlined />} onClick={() => { follow.current = true; if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; setNewMessages(false); }}>新消息</Button>}
      <footer className="wb-chat-composer">
        <div className="wb-chat-input-card">
          {previews.length > 0 && <div className="wb-chat-attachments">{previews.map((item, index) => <div key={item.url}><Image src={item.url} alt={item.name} /><Button type="text" size="small" aria-label={`移除图片${index + 1}`} onClick={() => setFiles(current => current.filter((_, position) => index !== position))}>移除</Button></div>)}</div>}
          <Input.TextArea aria-label="任务对话" value={draft} onChange={event => setDraft(event.target.value)} onPaste={paste} autoSize={{ minRows: 2, maxRows: 7 }} placeholder={active ? "补充要求或纠正方向，消息将在当前轮结束后处理…" : "和我说说你的想法、补充要求，或回复刚才的问题…"} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} />
          <div className="wb-chat-input-tools"><div><input type="file" hidden multiple accept="image/*" ref={fileRef} onChange={event => { addFiles(Array.from(event.target.files || [])); event.target.value = ""; }} /><Button type="text" icon={<PaperClipOutlined />} aria-label="添加图片" onClick={() => fileRef.current?.click()} />{!job && <Select aria-label="执行模型" value={provider} onChange={setProvider} options={[{ value: "codex", label: "智能模式" }, { value: "claude", label: "默认模式" }]} />}<span className="wb-chat-key-hint">Enter 发送 · Shift+Enter 换行</span></div><div>{active && job?.workbenchSession && <Button aria-label="停止执行" icon={<StopOutlined />} loading={acting} onClick={() => void perform(() => api.pauseWorkbench(job.jobId))}>停止</Button>}<Button type="primary" aria-label={notStarted && !draft.trim() ? "开始处理" : "发送消息"} icon={<SendOutlined />} loading={sending} disabled={loading || mergeBusy || (Boolean(job) && !notStarted && !draft.trim())} onClick={() => void submit()}>{notStarted && !draft.trim() ? "开始处理" : "发送"}</Button></div></div>
        </div>
        <p className="wb-chat-composer-note">{active ? "补充消息会保存在当前任务中；停止后可带着现有工作区继续。" : "可以继续提问、调整要求或推进实现。合并代码需要你确认。"}</p>
      </footer>
    </section>
    <aside className="wb-chat-inspector">
      {job?.tapdSync?.state === "failed" && <Alert type="warning" title={job.tapdSync.target === "done" ? "代码已合并，TAPD 状态待同步" : job.tapdSync.target === "open" ? "TAPD 未开始状态待同步" : "TAPD 进行中状态未同步"} description={job.tapdSync.error} action={<Button size="small" loading={acting} onClick={() => void perform(() => api.retryTapdSync(job.jobId))}>重试同步</Button>} />}
      {job?.tapdSync?.state === "pending" && <Alert type="info" title="正在同步 TAPD 任务状态…" />}
      {context?.itemType === "bug" && <Alert type="info" title="Bug 修复完成后，TAPD 状态请按项目缺陷流程处理；当前不会自动关闭 Bug。" />}
      <div className="wb-chat-tabs" role="tablist" aria-label="任务资料">{([["requirement", "需求"], ["changes", "变更"], ["activity", "活动"]] as const).map(([key, label]) => <button role="tab" aria-selected={panel === key} key={key} onClick={() => setPanel(key)}>{label}</button>)}</div>
      <div className="wb-chat-inspector-content">{panel === "requirement" ? <><h3>{context?.title || task.title}</h3><p>{context?.description || task.prompt}</p>{context && <a href={context.url} target="_blank" rel="noreferrer">查看 TAPD 原需求 ↗</a>}<dl><dt>业务项目</dt><dd>{task.businessProject}</dd><dt>代码仓库</dt><dd>{task.projectId === "b2b-composite" ? "B2B 管理后台" : task.projectId}</dd></dl></> : panel === "changes" ? <><CodeOutlined /><h3>{job?.commitSha ? "代码变更已生成" : "等待代码产出"}</h3><p>{job?.implementationSummary || "执行过程中的说明会显示在对话中。代码准备好后，可以在这里查看 Diff。"}</p>{job?.branch && <p className="wb-chat-muted">{job.branch}</p>}{diff && <div className="wb-chat-files"><p>{diff.files.length} 个文件 · <b>+{diff.additions}</b> / <i>−{diff.deletions}</i></p>{diff.files.map(file => <button key={file.path} onClick={() => { setDiffPath(file.path); setDiffOpen(true); }}><span>{file.path}</span><small>+{file.additions} / −{file.deletions}</small></button>)}</div>}{diffError && <Alert type="error" title={diffError} />}{job?.commitSha && <Button block onClick={() => { setDiffPath(undefined); setDiffOpen(true); }}>查看代码 Diff</Button>}{job?.previewUrl && <a className="wb-chat-preview" href={job.previewUrl} target="_blank" rel="noreferrer">打开页面预览 ↗</a>}{canReview(job) && <Button block autoInsertSpace={false} type="primary" loading={acting} onClick={() => setMergeOpen(true)}>完成</Button>}{job?.mergeRequestUrl && <a href={job.mergeRequestUrl} target="_blank" rel="noreferrer">查看 Merge Request ↗</a>}</> : <>{events.filter(event => ["stage", "agent_tool", "agent_status", "error"].includes(event.type) && event.phase !== "session_reply").map(event => <div className="wb-chat-activity" key={event.id}><time>{new Date(event.timestamp).toLocaleTimeString()}</time><p>{event.toolName ? `${event.toolName} ${event.toolDetail || ""}` : event.text || event.statusText || event.message}</p></div>)}</>}</div>
    </aside>
    <CodeDiffModal job={job} open={diffOpen} initialPath={diffPath} onClose={() => setDiffOpen(false)} />
    <Modal title="完成任务" open={mergeOpen} onCancel={() => setMergeOpen(false)} footer={[<Button key="cancel" onClick={() => setMergeOpen(false)}>返回查看</Button>, <Button key="merge" autoInsertSpace={false} type="primary" loading={acting} onClick={() => void perform(async () => { await api.merge(job!.jobId, false, task.tapdTask); setMergeOpen(false); })}>完成</Button>]}><p>确认 Review 通过后，将合并代码到仓库默认分支。关联的 TAPD 任务会在合并成功后同步为已完成。</p></Modal>
  </div>;
}
