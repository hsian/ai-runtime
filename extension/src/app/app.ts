import "../shared/styles.css";
import { loadConfig } from "../shared/config.js";
import {
  fetchCurrentTabPreview,
  fetchPageContext,
  fetchJobEvents,
  formatErrorMessage,
  isNotFoundError,
  openJobEventStream,
  cancelJob,
  discardMerge,
  executeJob,
  mergeJob,
  queryJobStatus,
  queryJobStatusWithRetry,
  submitPlan,
  submitJob,
} from "../shared/api.js";
import type { JobEvent, JobStatus, JobStatusType, PageContext, SubmitRequest } from "../shared/types.js";
import {
  MAX_ATTACHMENTS,
  HARD_MAX_BYTES,
  compressImageForUpload,
  formatBytes,
} from "../shared/imageCompress.js";
import { initCodingTaskPicker, refreshTaskDrawer } from "./codingTaskPicker.js";
import { setupComposerResize } from "./composerResize.js";
import { saveCodingPromptAsTask } from "../shared/requirementStore.js";

interface PendingAttachment {
  id: string;
  blob: Blob;
  previewUrl: string;
  label: string;
}

const AGENT_STREAM_KEY = "agent-stream";
const PLAN_RESULT_KEY = "plan-result";
const QUEUE_CARD_KEY = "queue-card";
const CONFIRM_CARD_KEY = "confirm-card";
const MERGE_CARD_KEY = "merge-card";

let activeStream: EventSource | null = null;
let activeJobId: string | null = null;
let currentJobStatus: JobStatusType | null = null;
const seenEventIds = new Set<string>();
let lastEventAt = Date.now();
let recoverAttemptAt = 0;
let lastLocalUserBubble:
  | { localId: string; text: string; pageUrl?: string; createdAtMs: number; imageUrls?: string[] }
  | null = null;
const pendingAttachments: PendingAttachment[] = [];
let planOutputBuffer = "";
let planOutputJobId: string | null = null;

function resetPlanOutputBuffer(jobId: string | null = null): void {
  planOutputBuffer = "";
  planOutputJobId = jobId;
}

function bufferPlanAgentDelta(jobId: string, delta: string): void {
  if (planOutputJobId !== jobId) {
    planOutputBuffer = "";
    planOutputJobId = jobId;
  }
  planOutputBuffer += delta;
}

function hasPlanResultBubble(jobId: string): boolean {
  return Boolean(
    el<HTMLElement>("chatMessages").querySelector(`[data-key="${PLAN_RESULT_KEY}-${jobId}"]`)
  );
}

function shouldBufferPlanOutput(jobId: string): boolean {
  if (currentJobStatus === "planning") return true;
  if (
    (currentJobStatus === "awaiting_confirm" || currentJobStatus === "awaiting_input") &&
    !hasPlanResultBubble(jobId)
  ) {
    return true;
  }
  return false;
}

function getPlanResultText(jobId: string): string | undefined {
  const node = el<HTMLElement>("chatMessages").querySelector<HTMLElement>(
    `[data-key="${PLAN_RESULT_KEY}-${jobId}"]`
  );
  if (!node) return undefined;

  const textarea = node.querySelector<HTMLTextAreaElement>("textarea.plan-edit");
  if (textarea) return textarea.value.trim();

  const bubble = node.querySelector<HTMLElement>(".msg-bubble");
  return bubble?.textContent?.trim();
}

function renderPlanResultBubble(jobId: string, text: string, editable: boolean): void {
  const trimmed = text.trim();
  if (!trimmed) return;

  const container = el<HTMLElement>("chatMessages");
  const key = `${PLAN_RESULT_KEY}-${jobId}`;
  let node = container.querySelector<HTMLElement>(`[data-key="${key}"]`);

  if (!node) {
    node = document.createElement("div");
    node.className = "msg msg-agent msg-plan-result";
    node.dataset.key = key;
    node.innerHTML = `<div class="msg-meta"></div>`;
    container.appendChild(node);
  }

  const meta = node.querySelector<HTMLElement>(".msg-meta")!;
  meta.textContent = editable ? "Plan 方案（可编辑）" : "Plan 方案";

  node.querySelector(".msg-bubble")?.remove();
  node.querySelector("textarea.plan-edit")?.remove();

  if (editable) {
    const textarea = document.createElement("textarea");
    textarea.className = "plan-edit msg-bubble";
    textarea.value = trimmed;
    textarea.rows = Math.min(20, Math.max(6, trimmed.split("\n").length + 1));
    textarea.spellcheck = false;
    node.appendChild(textarea);
  } else {
    const bubble = document.createElement("div");
    bubble.className = "msg-bubble";
    bubble.textContent = trimmed;
    node.appendChild(bubble);
  }

  container.appendChild(node);
}

function lockPlanResultBubble(jobId: string): void {
  const text = getPlanResultText(jobId);
  if (text) renderPlanResultBubble(jobId, text, false);
}

function flushPlanResultBubble(jobId: string, fallbackText?: string, editable = false): void {
  const text = (planOutputBuffer || fallbackText || "").trim();
  resetPlanOutputBuffer(null);

  const container = el<HTMLElement>("chatMessages");
  container.querySelector(`[data-key="${AGENT_STREAM_KEY}-${jobId}"]`)?.remove();

  if (!text) return;
  renderPlanResultBubble(jobId, text, editable);
}

function moveMessageToBottom(key: string): void {
  const container = el<HTMLElement>("chatMessages");
  const node = container.querySelector<HTMLElement>(`[data-key="${key}"]`);
  if (node) container.appendChild(node);
}

function isCancellableStatus(status: JobStatusType | null): boolean {
  return status === "planning" || status === "pending" || status === "running";
}

function updateSubmitButton(): void {
  const btn = el<HTMLButtonElement>("submitBtn");
  const cancellable = isCancellableStatus(currentJobStatus);
  btn.textContent = cancellable ? "取消" : "发送";
  btn.classList.toggle("danger", cancellable);
}

async function cancelActiveJob(): Promise<void> {
  const jobId = activeJobId;
  if (!jobId) return;
  const config = await loadConfig();
  if (!config.serverUrl) return;

  const ok = window.confirm("确认取消当前任务？\n\n- 将立即中断分析/修改\n- 本地代码会还原到修改前");
  if (!ok) return;

  const btn = el<HTMLButtonElement>("submitBtn");
  btn.disabled = true;

  try {
    setConnectionStatus("正在取消任务...");
    await cancelJob(config.serverUrl, jobId);
    // 取消事件会通过 SSE 再发一次；这里先乐观更新，避免用户感觉没反应
    currentJobStatus = "cancelled";
    updateSubmitButton();
    setConnectionStatus("任务已取消");
  } catch (err) {
    if (isNotFoundError(err)) {
      resetActiveJob("服务端任务已不存在（可能已重启或超时），请重新提交");
    } else {
      setConnectionStatus(formatErrorMessage(config.serverUrl, err));
    }
  } finally {
    btn.disabled = false;
  }
}

function shouldAutoSkipPlan(prompt: string): boolean {
  const text = prompt.trim();
  // 典型“简单可执行”指令：标题加/追加固定短串（如 123）
  return /(标题|title).*(加|追加|后面加|末尾加|加个)\s*([0-9a-zA-Z_-]{1,12})/i.test(text);
}

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function scrollChatToBottom(): void {
  const main = el<HTMLElement>("chatMain");
  requestAnimationFrame(() => {
    main.scrollTop = main.scrollHeight;
  });
}

function clearChatScreen(): void {
  el<HTMLElement>("chatMessages").innerHTML = "";
  seenEventIds.clear();
  lastLocalUserBubble = null;
}

function setupChatContextMenu(): void {
  const menu = document.createElement("div");
  menu.id = "chatContextMenu";
  menu.className = "chat-context-menu";
  menu.hidden = true;
  menu.innerHTML = `<button type="button" class="chat-context-item" data-action="clear">清屏</button>`;
  document.body.appendChild(menu);

  const hideMenu = (): void => {
    menu.hidden = true;
  };

  el<HTMLElement>("chatMain").addEventListener("contextmenu", (event) => {
    event.preventDefault();
    const padding = 8;
    const maxX = window.innerWidth - menu.offsetWidth - padding;
    const maxY = window.innerHeight - menu.offsetHeight - padding;
    menu.style.left = `${Math.min(event.clientX, maxX)}px`;
    menu.style.top = `${Math.min(event.clientY, maxY)}px`;
    menu.hidden = false;
  });

  menu.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.dataset.action === "clear") {
      clearChatScreen();
      hideMenu();
    }
  });

  document.addEventListener("click", hideMenu);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hideMenu();
  });
  window.addEventListener("blur", hideMenu);
}

function setConnectionStatus(text: string): void {
  el<HTMLElement>("connectionStatus").textContent = text;
}

function applyHeaderStatusFromJob(job: JobStatus): void {
  const labels: Record<JobStatusType, string> = {
    planning: "Plan 分析中",
    awaiting_confirm: "等待确认执行",
    awaiting_merge: "等待确认合并",
    awaiting_input: "需要补充信息",
    pending: job.jobsAhead ? `排队中，前面 ${job.jobsAhead} 个任务` : "排队中",
    running: "执行中",
    completed: "任务已完成",
    failed: "任务失败",
    cancelled: "任务已取消",
  };
  setConnectionStatus(labels[job.status] ?? "就绪");
}

function isCancelledEvent(event: JobEvent): boolean {
  if (event.type === "cancelled") return true;
  const text = `${event.message ?? ""}${event.text ?? ""}`;
  return event.type === "error" && text.includes("取消");
}

function confirmCardStatusLabel(status: JobStatusType): string {
  switch (status) {
    case "awaiting_confirm":
      return "";
    case "awaiting_input":
      return "需要补充信息（请重新提交更明确的需求）";
    case "cancelled":
      return "已取消";
    case "completed":
      return "已执行并完成";
    case "failed":
      return "执行失败";
    case "pending":
      return "已确认，排队中";
    case "running":
      return "已确认，执行中";
    case "planning":
      return "Plan 分析中";
    default:
      return "不可操作";
  }
}

function resetActiveJob(message: string): void {
  activeStream?.close();
  activeStream = null;
  activeJobId = null;
  currentJobStatus = null;
  void chrome.storage.local.remove(["lastJobId"]);
  updateSubmitButton();
  setConnectionStatus(message);
}

function renderPlanResultFromSummary(jobId: string, summary: string, editable = false): void {
  if (!summary.trim()) return;
  planOutputBuffer = summary;
  planOutputJobId = jobId;
  flushPlanResultBubble(jobId, summary, editable);
}

async function syncMissedJobEvents(serverUrl: string, jobId: string): Promise<void> {
  const events = await fetchJobEvents(serverUrl, jobId);
  for (const event of events) {
    handleJobEvent(event);
  }
}

function applyServerJobState(job: JobStatus): void {
  currentJobStatus = job.status;

  if (job.status === "awaiting_confirm" || job.status === "awaiting_input") {
    if (job.planSummary) {
      renderPlanResultFromSummary(job.jobId, job.planSummary, job.status === "awaiting_confirm");
    }
    upsertConfirmCard(job.jobId, job.status);
    setConnectionStatus(job.status === "awaiting_input" ? "需要补充信息" : "等待确认执行");
    updateSubmitButton();
    return;
  }

  if (job.status === "awaiting_merge") {
    upsertMergeConfirmCard(job.jobId, "awaiting_merge");
    setConnectionStatus("等待确认合并");
    updateSubmitButton();
    return;
  }

  if (job.status === "planning") {
    setConnectionStatus("Plan 分析中…");
    updateSubmitButton();
    return;
  }

  if (job.status === "pending" || job.status === "running") {
    setConnectionStatus(job.status === "running" ? "执行中" : "排队中");
    updateSubmitButton();
  }
}

async function recoverJobConnection(serverUrl: string, jobId: string): Promise<void> {
  if (activeJobId !== jobId || isTerminalStatus(currentJobStatus)) return;

  try {
    const job = await queryJobStatusWithRetry(serverUrl, jobId);
    await syncMissedJobEvents(serverUrl, jobId);
    applyServerJobState(job);

    if (isTerminalStatus(job.status)) {
      if (job.status === "failed") {
        setConnectionStatus(job.error ?? job.message ?? "Plan 执行失败");
        activeStream?.close();
        activeStream = null;
        updateSubmitButton();
      } else {
        resetActiveJob(
          job.status === "completed"
            ? "任务已完成（连接曾中断，已从服务端同步）"
            : job.status === "cancelled"
              ? "任务已取消"
              : job.error ?? job.message ?? "任务已结束"
        );
      }
      return;
    }

    if (job.status === "awaiting_confirm" || job.status === "awaiting_input" || job.status === "awaiting_merge") {
      return;
    }

    connectJobStream(serverUrl, jobId, job.status);
    setConnectionStatus("连接已恢复，继续接收进度…");
  } catch (err) {
    if (isNotFoundError(err)) {
      resetActiveJob("服务端任务已不存在（可能已重启或超时），请重新提交");
    }
  }
}

function renderPagePreview(url: string, title?: string): void {
  const pageTitleEl = el<HTMLElement>("pageTitle");
  const pageUrlEl = el<HTMLElement>("pageUrl");
  if (!url) {
    pageTitleEl.textContent = "AI Runtime";
    pageUrlEl.textContent = "未找到浏览器页面，请先打开测试环境页面";
    return;
  }
  pageTitleEl.textContent = title?.trim() ? title : "AI Runtime";
  pageUrlEl.textContent = url;
}

async function refreshPagePreview(): Promise<void> {
  const pageTitleEl = el<HTMLElement>("pageTitle");
  const pageUrlEl = el<HTMLElement>("pageUrl");
  pageTitleEl.textContent = "刷新中...";
  pageUrlEl.textContent = "";
  try {
    const preview = await fetchCurrentTabPreview();
    if (!preview) {
      renderPagePreview("");
      return;
    }
    renderPagePreview(preview.url, preview.title);
  } catch {
    renderPagePreview("");
  }
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return "";
  }
}

function ensureMessageElement(key: string, className: string): HTMLElement {
  const container = el<HTMLElement>("chatMessages");
  let node = container.querySelector<HTMLElement>(`[data-key="${key}"]`);
  if (!node) {
    node = document.createElement("div");
    node.className = className;
    node.dataset.key = key;
    container.appendChild(node);
  }
  return node;
}

function appendUserBubble(event: JobEvent, imageUrls?: string[]): void {
  const imagesHtml =
    imageUrls && imageUrls.length > 0
      ? `<div class="msg-images">${imageUrls.map((url) => `<img src="${url}" alt="截图" />`).join("")}</div>`
      : event.attachmentCount
        ? `<div class="msg-sub">📎 ${event.attachmentCount} 张截图</div>`
        : "";

  const node = document.createElement("div");
  node.className = "msg msg-user";
  node.dataset.key = event.id;
  node.innerHTML = `
    <div class="msg-meta">${formatTime(event.timestamp)}</div>
    <div class="msg-bubble">${escapeHtml(event.text ?? "")}</div>
    ${imagesHtml}
    ${event.pageUrl ? `<div class="msg-sub">${escapeHtml(event.pageUrl)}</div>` : ""}
  `;
  el<HTMLElement>("chatMessages").appendChild(node);
}

function tryReconcileServerUserEvent(event: JobEvent): boolean {
  const text = (event.text ?? "").trim();
  if (!text) return false;

  const container = el<HTMLElement>("chatMessages");

  if (lastLocalUserBubble && lastLocalUserBubble.text.trim() === text) {
    const localNode = container.querySelector<HTMLElement>(
      `[data-key="${lastLocalUserBubble.localId}"]`
    );
    if (localNode) {
      localNode.dataset.key = event.id;
      lastLocalUserBubble = null;
      return true;
    }
  }

  return mergePendingLocalUserBubble(event);
}

/** 将服务端 user 事件合并到尚未替换 id 的本地气泡（避免上传截图较慢时重复显示） */
function mergePendingLocalUserBubble(event: JobEvent): boolean {
  const text = (event.text ?? "").trim();
  if (!text) return false;

  const container = el<HTMLElement>("chatMessages");
  for (const node of container.querySelectorAll<HTMLElement>('.msg-user[data-key^="local-"]')) {
    const bubble = node.querySelector(".msg-bubble");
    if (bubble?.textContent?.trim() !== text) continue;
    if (lastLocalUserBubble?.localId === node.dataset.key) {
      lastLocalUserBubble = null;
    }
    node.dataset.key = event.id;
    return true;
  }
  return false;
}

function updateQueueCard(event: JobEvent): void {
  const node = ensureMessageElement(`${QUEUE_CARD_KEY}-${event.jobId}`, "msg msg-queue");
  const running = event.running;
  const waiting = event.waiting ?? [];

  const runningHtml = running
    ? `<li class="queue-running"><span>执行中</span> ${escapeHtml(running.prompt)}</li>`
    : "";

  const waitingHtml = waiting
    .map((item) => `<li><span>#${item.jobsAhead}</span> ${escapeHtml(item.prompt)}</li>`)
    .join("");

  node.innerHTML = `
    <div class="msg-meta">${formatTime(event.timestamp)} · 任务队列</div>
    <div class="queue-card">
      <div class="queue-title">${escapeHtml(event.text ?? "")}</div>
      <ul class="queue-list">${runningHtml}${waitingHtml}</ul>
    </div>
  `;
}

function appendStageBubble(event: JobEvent): void {
  const node = document.createElement("div");
  node.className = "msg msg-stage";
  node.dataset.key = event.id;
  node.innerHTML = `
    <div class="msg-meta">${formatTime(event.timestamp)}</div>
    <div class="stage-text">${escapeHtml(event.text ?? "")}</div>
  `;
  el<HTMLElement>("chatMessages").appendChild(node);
}

function upsertConfirmCard(jobId: string, status: JobStatusType = currentJobStatus ?? "awaiting_confirm"): void {
  const node = ensureMessageElement(`${CONFIRM_CARD_KEY}-${jobId}`, "msg msg-queue");
  const readonly = status !== "awaiting_confirm";
  const statusLabel = confirmCardStatusLabel(status);

  if (readonly) {
    node.innerHTML = `
      <div class="msg-meta">Plan 确认</div>
      <div class="queue-card">
        <div class="queue-title">Plan 完成：是否执行修改？</div>
        <div class="confirm-status">${escapeHtml(statusLabel)}</div>
      </div>
    `;
    moveMessageToBottom(`${CONFIRM_CARD_KEY}-${jobId}`);
    return;
  }

  node.innerHTML = `
    <div class="msg-meta">等待确认</div>
    <div class="queue-card">
      <div class="queue-title">Plan 完成：是否执行修改？</div>
      <div class="confirm-actions">
        <button class="primary" data-action="execute">执行修改</button>
        <button class="secondary" data-action="cancel">取消</button>
      </div>
      <div class="hint" style="margin-top:8px;">可直接编辑上方方案，确认后按编辑内容执行</div>
      <div class="hint" style="margin-top:4px;">执行完成后还需确认才会合并到 test</div>
    </div>
  `;
  moveMessageToBottom(`${CONFIRM_CARD_KEY}-${jobId}`);

  const execBtn = node.querySelector<HTMLButtonElement>('button[data-action="execute"]');
  const cancelBtn = node.querySelector<HTMLButtonElement>('button[data-action="cancel"]');
  if (execBtn) {
    execBtn.onclick = async () => {
      const config = await loadConfig();
      if (!config.serverUrl) return;
      try {
        execBtn.disabled = true;
        cancelBtn!.disabled = true;
        const planSummary = getPlanResultText(jobId);
        if (!planSummary) {
          setConnectionStatus("Plan 方案为空，请先填写方案内容");
          execBtn.disabled = false;
          cancelBtn!.disabled = false;
          return;
        }
        setConnectionStatus("已确认执行，正在加入队列...");
        await executeJob(config.serverUrl, jobId, planSummary);
        lockPlanResultBubble(jobId);
        currentJobStatus = "pending";
        upsertConfirmCard(jobId, "pending");
      } catch (err) {
        if (isNotFoundError(err)) {
          currentJobStatus = "cancelled";
          upsertConfirmCard(jobId, "cancelled");
          setConnectionStatus("历史任务已过期（服务端可能已重启），请重新提交");
        } else {
          setConnectionStatus(formatErrorMessage(config.serverUrl, err));
        }
        execBtn.disabled = false;
        cancelBtn!.disabled = false;
      }
    };
  }
  if (cancelBtn) {
    cancelBtn.onclick = async () => {
      const config = await loadConfig();
      if (!config.serverUrl) return;
      try {
        cancelBtn.disabled = true;
        execBtn!.disabled = true;
        await cancelJob(config.serverUrl, jobId);
        currentJobStatus = "cancelled";
        upsertConfirmCard(jobId, "cancelled");
        setConnectionStatus("任务已取消");
      } catch (err) {
        if (isNotFoundError(err)) {
          currentJobStatus = "cancelled";
          upsertConfirmCard(jobId, "cancelled");
          setConnectionStatus("历史任务已过期（服务端可能已重启），无需操作");
        } else {
          setConnectionStatus(formatErrorMessage(config.serverUrl, err));
        }
        cancelBtn.disabled = false;
        execBtn!.disabled = false;
      }
    };
  }
}

function mergeCardStatusLabel(status: JobStatusType): string {
  switch (status) {
    case "awaiting_merge":
      return "";
    case "running":
      return "正在合并到 test...";
    case "completed":
      return "已合并到 test";
    case "cancelled":
      return "已放弃合并";
    case "failed":
      return "合并失败";
    default:
      return "不可操作";
  }
}

function upsertMergeConfirmCard(jobId: string, status: JobStatusType = currentJobStatus ?? "awaiting_merge"): void {
  const node = ensureMessageElement(`${MERGE_CARD_KEY}-${jobId}`, "msg msg-queue");
  const readonly = status !== "awaiting_merge";
  const statusLabel = mergeCardStatusLabel(status);

  if (readonly) {
    node.innerHTML = `
      <div class="msg-meta">合并确认</div>
      <div class="queue-card">
        <div class="queue-title">修改已完成：是否合并到 test？</div>
        <div class="confirm-status">${escapeHtml(statusLabel)}</div>
      </div>
    `;
    moveMessageToBottom(`${MERGE_CARD_KEY}-${jobId}`);
    return;
  }

  node.innerHTML = `
    <div class="msg-meta">等待确认合并</div>
    <div class="queue-card">
      <div class="queue-title">修改已完成：是否合并到 test 并提交？</div>
      <div class="confirm-actions">
        <button class="primary" data-action="merge">合并到 test</button>
        <button class="secondary" data-action="discard">放弃</button>
      </div>
      <div class="hint" style="margin-top:8px;">放弃后将切回 test 分支，test 代码不做任何改动</div>
    </div>
  `;
  moveMessageToBottom(`${MERGE_CARD_KEY}-${jobId}`);

  const mergeBtn = node.querySelector<HTMLButtonElement>('button[data-action="merge"]');
  const discardBtn = node.querySelector<HTMLButtonElement>('button[data-action="discard"]');
  if (mergeBtn) {
    mergeBtn.onclick = async () => {
      const config = await loadConfig();
      if (!config.serverUrl) return;
      try {
        mergeBtn.disabled = true;
        discardBtn!.disabled = true;
        setConnectionStatus("已确认合并，正在处理...");
        await mergeJob(config.serverUrl, jobId);
        currentJobStatus = "running";
        upsertMergeConfirmCard(jobId, "running");
      } catch (err) {
        if (isNotFoundError(err)) {
          currentJobStatus = "cancelled";
          upsertMergeConfirmCard(jobId, "cancelled");
          setConnectionStatus("历史任务已过期（服务端可能已重启），请重新提交");
        } else {
          setConnectionStatus(formatErrorMessage(config.serverUrl, err));
        }
        mergeBtn.disabled = false;
        discardBtn!.disabled = false;
      }
    };
  }
  if (discardBtn) {
    discardBtn.onclick = async () => {
      const config = await loadConfig();
      if (!config.serverUrl) return;
      try {
        discardBtn.disabled = true;
        mergeBtn!.disabled = true;
        await discardMerge(config.serverUrl, jobId);
        currentJobStatus = "cancelled";
        upsertMergeConfirmCard(jobId, "cancelled");
        setConnectionStatus("已放弃合并");
      } catch (err) {
        if (isNotFoundError(err)) {
          currentJobStatus = "cancelled";
          upsertMergeConfirmCard(jobId, "cancelled");
          setConnectionStatus("历史任务已过期（服务端可能已重启），无需操作");
        } else {
          setConnectionStatus(formatErrorMessage(config.serverUrl, err));
        }
        discardBtn.disabled = false;
        mergeBtn!.disabled = false;
      }
    };
  }
}

function appendAgentDelta(delta: string, jobId?: string): void {
  const effectiveJobId = jobId ?? activeJobId ?? "unknown";
  if (shouldBufferPlanOutput(effectiveJobId)) {
    bufferPlanAgentDelta(effectiveJobId, delta);
    return;
  }

  const key = `${AGENT_STREAM_KEY}-${effectiveJobId}`;
  const node = ensureMessageElement(key, "msg msg-agent");
  let bubble = node.querySelector<HTMLElement>(".msg-bubble");
  let meta = node.querySelector<HTMLElement>(".msg-meta");

  if (!bubble) {
    node.innerHTML = `<div class="msg-meta">Claude</div><div class="msg-bubble"></div>`;
    bubble = node.querySelector<HTMLElement>(".msg-bubble")!;
    meta = node.querySelector<HTMLElement>(".msg-meta")!;
  }

  meta!.textContent = "Claude · 输出中…";
  bubble!.textContent += delta;
}

function appendToolLine(event: JobEvent): void {
  const node = document.createElement("div");
  node.className = "msg msg-tool";
  node.dataset.key = event.id;
  node.innerHTML = `<div class="tool-line">${escapeHtml(event.text ?? event.toolName ?? "")}</div>`;
  el<HTMLElement>("chatMessages").appendChild(node);
}

function finalizeAgentStream(): void {
  if (!activeJobId) return;
  const key = `${AGENT_STREAM_KEY}-${activeJobId}`;
  const node = el<HTMLElement>("chatMessages").querySelector<HTMLElement>(`[data-key="${key}"]`);
  const meta = node?.querySelector<HTMLElement>(".msg-meta");
  if (meta) meta.textContent = "Claude";
}

function appendDoneBubble(event: JobEvent): void {
  finalizeAgentStream();
  const node = document.createElement("div");
  node.className = "msg msg-done";
  node.dataset.key = event.id;
  const text = escapeHtml(event.text ?? event.message ?? "任务完成");
  const branchInfo = event.branch
    ? `<div class="msg-sub">分支: ${escapeHtml(event.branch)}</div>`
    : "";
  node.innerHTML = `
    <div class="msg-meta">${formatTime(event.timestamp)} · 完成</div>
    <div class="msg-bubble">${text}</div>
    ${branchInfo}
  `;
  el<HTMLElement>("chatMessages").appendChild(node);
}

function appendCancelledBubble(event: JobEvent): void {
  const node = document.createElement("div");
  node.className = "msg msg-cancelled";
  node.dataset.key = event.id;
  node.innerHTML = `
    <div class="msg-meta">${formatTime(event.timestamp)} · 已取消</div>
    <div class="msg-bubble">${escapeHtml(event.message ?? event.text ?? "任务已取消")}</div>
  `;
  el<HTMLElement>("chatMessages").appendChild(node);
}

function appendErrorBubble(event: JobEvent): void {
  finalizeAgentStream();
  const node = document.createElement("div");
  node.className = "msg msg-error";
  node.dataset.key = event.id;
  node.innerHTML = `
    <div class="msg-meta">${formatTime(event.timestamp)} · 失败</div>
    <div class="msg-bubble">${escapeHtml(event.message ?? event.text ?? "任务失败")}</div>
  `;
  el<HTMLElement>("chatMessages").appendChild(node);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderAttachmentStrip(): void {
  const strip = el<HTMLElement>("attachmentStrip");
  if (pendingAttachments.length === 0) {
    strip.hidden = true;
    strip.innerHTML = "";
    return;
  }

  strip.hidden = false;
  strip.innerHTML = pendingAttachments
    .map(
      (item) => `
        <div class="attachment-item" data-attachment-id="${item.id}">
          <img src="${item.previewUrl}" alt="${escapeHtml(item.label)}" />
          <span class="attachment-size">${escapeHtml(item.label)}</span>
          <button type="button" data-remove-attachment="${item.id}" title="移除">×</button>
        </div>
      `
    )
    .join("");

  strip.querySelectorAll<HTMLButtonElement>("[data-remove-attachment]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset.removeAttachment;
      if (id) removeAttachment(id);
    });
  });
}

function removeAttachment(id: string): void {
  const index = pendingAttachments.findIndex((item) => item.id === id);
  if (index < 0) return;
  URL.revokeObjectURL(pendingAttachments[index].previewUrl);
  pendingAttachments.splice(index, 1);
  renderAttachmentStrip();
}

function detachPendingAttachments(): { blobs: Blob[]; previewUrls: string[] } {
  const blobs = pendingAttachments.map((item) => item.blob);
  const previewUrls = pendingAttachments.map((item) => item.previewUrl);
  pendingAttachments.length = 0;
  renderAttachmentStrip();
  return { blobs, previewUrls };
}

async function addAttachmentFromFile(file: File): Promise<void> {
  if (!file.type.startsWith("image/")) {
    setConnectionStatus("仅支持图片文件");
    return;
  }
  if (pendingAttachments.length >= MAX_ATTACHMENTS) {
    setConnectionStatus(`最多添加 ${MAX_ATTACHMENTS} 张截图`);
    return;
  }

  setConnectionStatus("正在压缩截图…");
  try {
    const blob = await compressImageForUpload(file);
    if (blob.size > HARD_MAX_BYTES) {
      setConnectionStatus(`截图过大（${formatBytes(blob.size)}），请裁剪后重试`);
      return;
    }

    const previewUrl = URL.createObjectURL(blob);
    pendingAttachments.push({
      id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      blob,
      previewUrl,
      label: formatBytes(blob.size),
    });
    renderAttachmentStrip();
    setConnectionStatus("就绪");
  } catch (err) {
    setConnectionStatus(err instanceof Error ? err.message : "截图处理失败");
  }
}

function setupAttachmentHandlers(): void {
  const prompt = el<HTMLTextAreaElement>("prompt");
  const composer = el<HTMLElement>("composer");

  prompt.addEventListener("paste", (event) => {
    const items = event.clipboardData?.items;
    if (!items) return;

    let handledImage = false;
    for (const item of items) {
      if (!item.type.startsWith("image/")) continue;
      const file = item.getAsFile();
      if (!file) continue;
      handledImage = true;
      void addAttachmentFromFile(file);
    }

    if (handledImage) {
      event.preventDefault();
    }
  });

  composer.addEventListener("dragover", (event) => {
    event.preventDefault();
  });

  composer.addEventListener("drop", (event) => {
    event.preventDefault();
    const files = Array.from(event.dataTransfer?.files ?? []).filter((file) =>
      file.type.startsWith("image/")
    );
    for (const file of files) {
      void addAttachmentFromFile(file);
    }
  });
}

function handleJobEvent(event: JobEvent): void {
  if (seenEventIds.has(event.id)) return;
  seenEventIds.add(event.id);
  lastEventAt = Date.now();

  switch (event.type) {
    case "user":
      if (!tryReconcileServerUserEvent(event)) {
        appendUserBubble(event);
      }
      break;
    case "queue":
      updateQueueCard(event);
      break;
    case "stage":
      appendStageBubble(event);
      if (event.phase === "plan_done") {
        flushPlanResultBubble(event.jobId, undefined, true);
        currentJobStatus = "awaiting_confirm";
        upsertConfirmCard(event.jobId, "awaiting_confirm");
        setConnectionStatus("等待确认执行");
        updateSubmitButton();
      } else if (event.phase === "plan_need_more") {
        flushPlanResultBubble(event.jobId);
        currentJobStatus = "awaiting_input";
        upsertConfirmCard(event.jobId, "awaiting_input");
        setConnectionStatus("需要补充信息");
        updateSubmitButton();
      } else if (event.phase === "execute_confirmed") {
        lockPlanResultBubble(event.jobId);
        currentJobStatus = "pending";
        upsertConfirmCard(event.jobId, "pending");
        setConnectionStatus("已确认执行，排队中");
        updateSubmitButton();
      } else if (event.phase === "execute_ready") {
        currentJobStatus = "awaiting_merge";
        upsertMergeConfirmCard(event.jobId, "awaiting_merge");
        setConnectionStatus("等待确认合并");
        updateSubmitButton();
      } else if (event.phase === "merge") {
        const hasMergeCard = Boolean(
          el<HTMLElement>("chatMessages").querySelector(`[data-key="${MERGE_CARD_KEY}-${event.jobId}"]`)
        );
        const fromMergeConfirm = currentJobStatus === "awaiting_merge" || hasMergeCard;
        currentJobStatus = "running";
        if (fromMergeConfirm) {
          upsertMergeConfirmCard(event.jobId, "running");
          setConnectionStatus("正在合并到 test");
        } else {
          setConnectionStatus("执行中");
        }
        updateSubmitButton();
      } else if (event.phase && ["pull", "branch", "agent", "commit"].includes(event.phase)) {
        currentJobStatus = "running";
        setConnectionStatus("执行中");
        updateSubmitButton();
      } else if (event.phase === "plan") {
        resetPlanOutputBuffer(event.jobId);
        currentJobStatus = "planning";
        setConnectionStatus("Plan 分析中");
        updateSubmitButton();
      }
      break;
    case "agent_text":
      if (event.delta) appendAgentDelta(event.delta, event.jobId);
      break;
    case "agent_tool":
      appendToolLine(event);
      break;
    case "done":
      currentJobStatus = "completed";
      appendDoneBubble(event);
      upsertConfirmCard(event.jobId, "completed");
      upsertMergeConfirmCard(event.jobId, "completed");
      setConnectionStatus("任务已完成");
      activeStream?.close();
      activeStream = null;
      updateSubmitButton();
      break;
    case "cancelled":
      resetPlanOutputBuffer(null);
      currentJobStatus = "cancelled";
      appendCancelledBubble(event);
      upsertConfirmCard(event.jobId, "cancelled");
      upsertMergeConfirmCard(event.jobId, "cancelled");
      setConnectionStatus("任务已取消");
      activeStream?.close();
      activeStream = null;
      updateSubmitButton();
      break;
    case "error":
      resetPlanOutputBuffer(null);
      if (isCancelledEvent(event)) {
        currentJobStatus = "cancelled";
        appendCancelledBubble(event);
        upsertConfirmCard(event.jobId, "cancelled");
        upsertMergeConfirmCard(event.jobId, "cancelled");
        setConnectionStatus("任务已取消");
      } else {
        currentJobStatus = "failed";
        appendErrorBubble(event);
        setConnectionStatus("任务失败");
      }
      activeStream?.close();
      activeStream = null;
      updateSubmitButton();
      break;
  }

  scrollChatToBottom();
}

function connectJobStream(serverUrl: string, jobId: string, initialStatus?: JobStatusType): void {
  activeStream?.close();
  activeJobId = jobId;
  if (initialStatus) currentJobStatus = initialStatus;
  setConnectionStatus("加载任务记录…");
  lastEventAt = Date.now();
  recoverAttemptAt = 0;

  activeStream = openJobEventStream(serverUrl, jobId, handleJobEvent, {
    onOpen: () => {
      if (currentJobStatus) {
        applyHeaderStatusFromJob({ jobId, status: currentJobStatus, createdAt: "", updatedAt: "" });
      } else {
        setConnectionStatus("已连接");
      }
      updateSubmitButton();
    },
    onError: () => {
      const quietMs = Date.now() - lastEventAt;
      const recoverAfterMs = currentJobStatus === "planning" ? 120_000 : 20_000;
      if (quietMs > 4000 && activeStream && !isTerminalStatus(currentJobStatus)) {
        setConnectionStatus("Plan 分析中，连接不稳定，正在自动重试…");
      }
      if (
        quietMs > recoverAfterMs &&
        activeJobId === jobId &&
        !isTerminalStatus(currentJobStatus) &&
        currentJobStatus !== "awaiting_confirm" &&
        currentJobStatus !== "awaiting_input" &&
        currentJobStatus !== "awaiting_merge" &&
        Date.now() - recoverAttemptAt > 15_000
      ) {
        recoverAttemptAt = Date.now();
        void recoverJobConnection(serverUrl, jobId);
      }
    },
    onClose: () => {
      if (
        activeJobId === jobId &&
        !isTerminalStatus(currentJobStatus) &&
        currentJobStatus !== "awaiting_confirm" &&
        currentJobStatus !== "awaiting_input" &&
        currentJobStatus !== "awaiting_merge"
      ) {
        void recoverJobConnection(serverUrl, jobId);
        return;
      }
      if (activeStream && currentJobStatus) {
        applyHeaderStatusFromJob({ jobId, status: currentJobStatus, createdAt: "", updatedAt: "" });
      }
    },
  });
}

function isTerminalStatus(status: JobStatusType | null): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

let pageConfirmResolver: ((confirmed: boolean) => void) | null = null;

function closePageConfirmModal(confirmed: boolean): void {
  const modal = document.getElementById("pageConfirmModal");
  if (modal) modal.hidden = true;
  const resolver = pageConfirmResolver;
  pageConfirmResolver = null;
  resolver?.(confirmed);
}

function showPageConfirmModal(pageContext: PageContext | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = el<HTMLElement>("pageConfirmModal");
    const titleEl = el<HTMLElement>("pageConfirmTitle");
    const urlEl = el<HTMLElement>("pageConfirmUrl");
    const hintEl = el<HTMLElement>("pageConfirmHint");
    const okBtn = el<HTMLButtonElement>("pageConfirmOk");

    pageConfirmResolver = resolve;

    if (!pageContext?.url) {
      titleEl.textContent = "未找到浏览器页面";
      urlEl.textContent = "请先在浏览器打开要修改的测试页面";
      hintEl.textContent = "无法获取页面上下文时不能发送任务。";
      okBtn.disabled = true;
    } else {
      titleEl.textContent = pageContext.title?.trim() || "当前页面";
      urlEl.textContent = pageContext.url;
      hintEl.textContent = "Plan 会结合当前页面 URL 定位源码，请确认这就是你要改的那个页面。";
      okBtn.disabled = false;
    }

    modal.hidden = false;
    if (!okBtn.disabled) {
      okBtn.focus();
    } else {
      el<HTMLButtonElement>("pageConfirmCancel").focus();
    }
  });
}

function setupPageConfirmModal(): void {
  el<HTMLButtonElement>("pageConfirmOk").addEventListener("click", () => {
    closePageConfirmModal(true);
  });
  el<HTMLButtonElement>("pageConfirmCancel").addEventListener("click", () => {
    closePageConfirmModal(false);
  });
  el<HTMLElement>("pageConfirmBackdrop").addEventListener("click", () => {
    closePageConfirmModal(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const modal = document.getElementById("pageConfirmModal");
    if (modal && !modal.hidden) {
      closePageConfirmModal(false);
    }
  });
}

async function handleSubmit(): Promise<void> {
  // 任务进行中：发送按钮变为“取消”
  if (isCancellableStatus(currentJobStatus)) {
    await cancelActiveJob();
    return;
  }

  const prompt = el<HTMLTextAreaElement>("prompt").value.trim();
  const includeContext = true;
  const usePlanMode = el<HTMLInputElement>("usePlanMode")?.checked ?? false;
  const submitBtn = el<HTMLButtonElement>("submitBtn");
  const config = await loadConfig();

  if (!prompt) {
    setConnectionStatus("请输入修改需求");
    return;
  }
  if (!config.serverUrl) {
    setConnectionStatus("请先在设置中配置服务端地址");
    return;
  }

  const pageContext = await fetchPageContext(includeContext);
  if (pageContext) {
    renderPagePreview(pageContext.url, pageContext.title);
  }

  const confirmed = await showPageConfirmModal(pageContext);
  if (!confirmed) {
    setConnectionStatus("已取消发送");
    return;
  }

  void saveCodingPromptAsTask({
    prompt,
    pageUrl: pageContext?.url,
    pageTitle: pageContext?.title,
  }).then(() => refreshTaskDrawer());

  submitBtn.disabled = true;
  seenEventIds.clear();
  resetPlanOutputBuffer(null);

  try {
    currentJobStatus = null;
    updateSubmitButton();

    const { blobs: imageBlobs, previewUrls } = detachPendingAttachments();
    const body: SubmitRequest = {
      prompt,
      pageContext,
      images: imageBlobs.length > 0 ? imageBlobs : undefined,
    };
    const effectivePlan = usePlanMode && !shouldAutoSkipPlan(prompt);
    if (usePlanMode && !effectivePlan) {
      setConnectionStatus("已识别为简单改动：跳过 Plan，直接执行…");
    }

    // 立即显示用户消息，避免等待接口期间“没反应”
    const localId = `local-${Date.now()}`;
    appendUserBubble(
      {
        id: localId,
        jobId: "pending",
        timestamp: new Date().toISOString(),
        type: "user",
        text: prompt,
        pageUrl: pageContext?.url,
        attachmentCount: previewUrls.length > 0 ? previewUrls.length : undefined,
      },
      previewUrls
    );
    lastLocalUserBubble = {
      localId,
      text: prompt,
      pageUrl: pageContext?.url,
      createdAtMs: Date.now(),
      imageUrls: previewUrls,
    };
    scrollChatToBottom();

    let data: Awaited<ReturnType<typeof submitJob>>;
    try {
      data = effectivePlan
        ? await submitPlan(config.serverUrl, body)
        : await submitJob(config.serverUrl, body);
    } catch (submitErr) {
      for (const [index, blob] of imageBlobs.entries()) {
        pendingAttachments.push({
          id: `att-restore-${Date.now()}-${index}`,
          blob,
          previewUrl: previewUrls[index],
          label: formatBytes(blob.size),
        });
      }
      renderAttachmentStrip();
      throw submitErr;
    }

    el<HTMLTextAreaElement>("prompt").value = "";
    await chrome.storage.local.set({ lastJobId: data.jobId });
    resetPlanOutputBuffer(data.jobId);

    connectJobStream(config.serverUrl, data.jobId, data.status as JobStatusType);
    setConnectionStatus(effectivePlan ? "Plan 分析中…" : data.jobsAhead ? `排队中，前面 ${data.jobsAhead} 个任务` : "任务已提交");
  } catch (err) {
    setConnectionStatus(formatErrorMessage(config.serverUrl, err));
  } finally {
    submitBtn.disabled = false;
    updateSubmitButton();
  }
}

async function init(): Promise<void> {
  const stored = await chrome.storage.local.get(["lastJobId"]);
  const config = await loadConfig();

  await refreshPagePreview();

  el<HTMLElement>("settingsBtn").addEventListener("click", () => {
    window.location.href = chrome.runtime.getURL("settings.html");
  });
  el<HTMLButtonElement>("requirementBtn").addEventListener("click", () => {
    window.location.href = chrome.runtime.getURL("requirement.html");
  });
  initCodingTaskPicker({
    onSelect: (task) => {
      el<HTMLTextAreaElement>("prompt").value = task.draftPrompt;
      setConnectionStatus(`已载入任务：${task.title}`);
    },
  });
  el<HTMLElement>("refreshPageBtn").addEventListener("click", refreshPagePreview);
  el<HTMLButtonElement>("submitBtn").addEventListener("click", handleSubmit);
  setupAttachmentHandlers();
  setupComposerResize();
  setupChatContextMenu();
  setupPageConfirmModal();

  el<HTMLTextAreaElement>("prompt").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSubmit();
    }
  });

  window.addEventListener("focus", refreshPagePreview);
  updateSubmitButton();

  if (stored.lastJobId && config.serverUrl) {
    try {
      const job = await queryJobStatus(config.serverUrl, stored.lastJobId as string);
      await syncMissedJobEvents(config.serverUrl, job.jobId);
      applyServerJobState(job);
      if (
        job.status === "planning" ||
        job.status === "pending" ||
        job.status === "running" ||
        job.status === "awaiting_confirm" ||
        job.status === "awaiting_merge"
      ) {
        connectJobStream(config.serverUrl, job.jobId, job.status);
      }
    } catch {
      await chrome.storage.local.remove(["lastJobId"]);
      setConnectionStatus("就绪");
    }
  }
}

init();
