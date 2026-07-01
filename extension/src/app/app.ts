import "../shared/styles.css";
import "../shared/shellView.css";
import { initTapdBatchPanel } from "../tapd-batch/tapd-batch.js";
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
  flushPendingServerCancel,
  fetchReleaseBranches,
  mergeJob,
  mergeJobToReleaseBranch,
  revertJobFromDefaultBranch,
  queryJobStatus,
  queryJobStatusWithRetry,
  replyToPlan,
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
import { attachJobToCodingTask, saveCodingPromptAsTask } from "../shared/codingTaskStore.js";
import { mountPlanConfirmCard } from "../shared/planConfirmCard.js";
import {
  appendCodingJobEvent,
  clearCodingJobSession,
  clearPendingServerCancel,
  getCodingJobSession,
  getPendingServerCancelJobId,
  initCodingJobSession,
  markPendingServerCancel,
  type CodingJobSession,
} from "../shared/codingJobStore.js";

interface PendingAttachment {
  id: string;
  blob: Blob;
  previewUrl: string;
  label: string;
}

const AGENT_STREAM_KEY = "agent-stream";
const AGENT_STATUS_KEY = "agent-status";
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
let recoveryStopped = false;
let recoveryFailureCount = 0;
let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
const MAX_RECOVERY_FAILURES = 3;
const RECOVER_QUIET_MS = 12_000;
const RECOVER_RETRY_GAP_MS = 8_000;
const PENDING_CANCEL_RETRY_MS = 10_000;

let pendingCancelRetryTimer: ReturnType<typeof setInterval> | null = null;
let lastLocalUserBubble:
  | { localId: string; text: string; pageUrl?: string; createdAtMs: number; imageUrls?: string[] }
  | null = null;
const pendingAttachments: PendingAttachment[] = [];
const previewUrls = new Map<string, string>();
const previewMessages = new Map<string, string>();
let planOutputBuffer = "";
let planOutputJobId: string | null = null;
let createMergeRequestOnMerge = false;

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

function stopPendingCancelRetry(): void {
  if (!pendingCancelRetryTimer) return;
  clearInterval(pendingCancelRetryTimer);
  pendingCancelRetryTimer = null;
}

async function tryFlushPendingServerCancel(serverUrl: string): Promise<void> {
  const settled = await flushPendingServerCancel(serverUrl);
  if (settled) stopPendingCancelRetry();
}

function startPendingCancelRetry(serverUrl: string): void {
  void tryFlushPendingServerCancel(serverUrl);
  if (pendingCancelRetryTimer) return;
  pendingCancelRetryTimer = setInterval(() => {
    void tryFlushPendingServerCancel(serverUrl);
  }, PENDING_CANCEL_RETRY_MS);
}

async function ensurePendingCancelRetry(serverUrl: string): Promise<void> {
  const pending = await getPendingServerCancelJobId();
  if (pending) startPendingCancelRetry(serverUrl);
}

function resetJobRecovery(): void {
  recoveryStopped = false;
  recoveryFailureCount = 0;
  recoverAttemptAt = 0;
  if (recoveryTimer) {
    clearTimeout(recoveryTimer);
    recoveryTimer = null;
  }
}

function stopJobRecovery(): void {
  recoveryStopped = true;
  if (recoveryTimer) {
    clearTimeout(recoveryTimer);
    recoveryTimer = null;
  }
  activeStream?.close();
  activeStream = null;
}

function applyLocalJobCancelled(jobId: string, message: string): void {
  stopJobRecovery();
  activeJobId = null;
  void chrome.storage.local.remove(["lastJobId"]);

  if (currentJobStatus === "cancelled") {
    updateSubmitButton();
    setConnectionStatus(message);
    return;
  }

  handleJobEvent({
    id: `local-cancel-${Date.now()}`,
    jobId,
    timestamp: new Date().toISOString(),
    type: "cancelled",
    text: message,
    message,
  });
}

function abandonActiveJob(message: string): void {
  stopJobRecovery();
  activeJobId = null;
  currentJobStatus = null;
  void chrome.storage.local.remove(["lastJobId"]);
  updateSubmitButton();
  setConnectionStatus(message);
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
    await clearPendingServerCancel();
    applyLocalJobCancelled(jobId, "任务已取消");
  } catch {
    await markPendingServerCancel(jobId);
    applyLocalJobCancelled(jobId, "任务已取消（服务不可用，已在本地结束）");
    startPendingCancelRetry(config.serverUrl);
  } finally {
    btn.disabled = false;
    updateSubmitButton();
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

function clearChatDom(): void {
  el<HTMLElement>("chatMessages").innerHTML = "";
  seenEventIds.clear();
  lastLocalUserBubble = null;
}

function clearChatScreen(): void {
  clearChatDom();
  void clearCodingJobSession();
  void chrome.storage.local.remove(["lastJobId"]);
}

function persistJobEvent(event: JobEvent): void {
  appendCodingJobEvent(event.jobId, event, {
    status: currentJobStatus ?? undefined,
    planSummary: getPlanResultText(event.jobId),
  });
}

async function restoreChatFromSession(): Promise<CodingJobSession | null> {
  const session = await getCodingJobSession();
  if (!session || session.events.length === 0) return session;

  clearChatDom();
  activeJobId = session.jobId;
  currentJobStatus = session.status;

  for (const event of session.events) {
    handleJobEvent(event, { skipPersist: true });
  }

  if (session.planSummary && !hasPlanResultBubble(session.jobId)) {
    renderPlanResultFromSummary(
      session.jobId,
      session.planSummary,
      session.status === "awaiting_confirm"
    );
  }

  return session;
}

function isStreamRecoverableStatus(status: JobStatusType): boolean {
  return status === "planning" || status === "running";
}

function isStaticRecoverableStatus(status: JobStatusType): boolean {
  return status === "awaiting_confirm" || status === "awaiting_input" || status === "awaiting_merge";
}

function scheduleJobRecovery(serverUrl: string, jobId: string, delayMs: number): void {
  if (
    recoveryStopped ||
    activeJobId !== jobId ||
    isTerminalStatus(currentJobStatus)
  ) {
    return;
  }

  if (recoveryTimer) return;
  recoveryTimer = setTimeout(() => {
    recoveryTimer = null;
    void recoverJobConnection(serverUrl, jobId);
  }, Math.max(0, delayMs));
}

function isServerRestartedJob(job: JobStatus): boolean {
  return job.status === "cancelled" && (job.message?.includes("重启") ?? false);
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
      return "需要补充信息";
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
  stopJobRecovery();
  activeJobId = null;
  currentJobStatus = null;
  void chrome.storage.local.remove(["lastJobId"]);
  updateSubmitButton();
  setConnectionStatus(message);
}

/** 启动时发现本地 jobId 在服务端已不存在：保留本地聊天记录，恢复就绪状态 */
function dismissStaleJob(localStatus?: JobStatusType): void {
  activeStream?.close();
  activeStream = null;
  activeJobId = null;
  currentJobStatus = localStatus && isTerminalStatus(localStatus) ? localStatus : null;
  void chrome.storage.local.remove(["lastJobId"]);
  updateSubmitButton();

  if (localStatus && isTerminalStatus(localStatus)) {
    applyHeaderStatusFromJob({
      jobId: "",
      status: localStatus,
      createdAt: "",
      updatedAt: "",
    });
    return;
  }

  setConnectionStatus("就绪");
}

function renderPlanResultFromSummary(jobId: string, summary: string, editable = false): void {
  if (!summary.trim()) return;
  planOutputBuffer = summary;
  planOutputJobId = jobId;
  flushPlanResultBubble(jobId, summary, editable);
}

async function hydratePlanSummaryFromServer(jobId: string): Promise<void> {
  const config = await loadConfig();
  if (!config.serverUrl) return;
  try {
    const job = await queryJobStatus(config.serverUrl, jobId);
    if (job.planSummary?.trim()) {
      planOutputBuffer = job.planSummary;
      planOutputJobId = jobId;
    }
  } catch {
    // keep buffered stream text as fallback
  }
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
    upsertMergeConfirmCard(job.jobId, "awaiting_merge", job.previewUrl, job.previewMessage);
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
  if (
    recoveryStopped ||
    activeJobId !== jobId ||
    isTerminalStatus(currentJobStatus)
  ) {
    return;
  }

  const retryInMs = RECOVER_RETRY_GAP_MS - (Date.now() - recoverAttemptAt);
  if (retryInMs > 0) {
    scheduleJobRecovery(serverUrl, jobId, retryInMs);
    return;
  }
  recoverAttemptAt = Date.now();

  try {
    const job = await queryJobStatusWithRetry(serverUrl, jobId, 2);
    recoveryFailureCount = 0;

    if (isServerRestartedJob(job)) {
      abandonActiveJob("服务已断开，请重新提交");
      return;
    }

    if (job.status === "pending") {
      abandonActiveJob("连接已断开，排队任务已失效，请重新提交");
      return;
    }

    await syncMissedJobEvents(serverUrl, job.jobId);
    applyServerJobState(job);

    if (isTerminalStatus(job.status)) {
      if (job.status === "failed") {
        setConnectionStatus(job.error ?? job.message ?? "Plan 执行失败");
        stopJobRecovery();
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

    if (isStaticRecoverableStatus(job.status)) {
      return;
    }

    if (!isStreamRecoverableStatus(job.status)) {
      abandonActiveJob("服务已断开，请重新提交");
      return;
    }

    connectJobStream(serverUrl, jobId, job.status);
    setConnectionStatus("连接已恢复，继续接收进度…");
  } catch (err) {
    recoveryFailureCount += 1;

    if (isNotFoundError(err) || recoveryFailureCount >= MAX_RECOVERY_FAILURES) {
      abandonActiveJob(
        isNotFoundError(err)
          ? "服务已断开，请重新提交"
          : "无法连接服务，请检查服务是否启动后重新提交"
      );
      return;
    }

    setConnectionStatus(`连接中断，正在重试（${recoveryFailureCount}/${MAX_RECOVERY_FAILURES}）…`);
    scheduleJobRecovery(serverUrl, jobId, RECOVER_RETRY_GAP_MS);
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
    <div class="stage-text">${linkifyText(event.text ?? "")}</div>
  `;
  el<HTMLElement>("chatMessages").appendChild(node);
}

function upsertConfirmCard(jobId: string, status: JobStatusType = currentJobStatus ?? "awaiting_confirm"): void {
  const node = ensureMessageElement(`${CONFIRM_CARD_KEY}-${jobId}`, "msg msg-queue");
  mountPlanConfirmCard(node, jobId, status, {
    getPlanText: (id) => getPlanResultText(id) ?? "",
    onExecute: async (id, planSummary) => {
      const config = await loadConfig();
      if (!config.serverUrl) return;
      if (!planSummary) {
        setConnectionStatus("Plan 方案为空，请先填写方案内容");
        return;
      }
      try {
        setConnectionStatus("已确认执行，正在加入队列...");
        await executeJob(config.serverUrl, id, planSummary);
        lockPlanResultBubble(id);
        currentJobStatus = "pending";
        upsertConfirmCard(id, "pending");
      } catch (err) {
        if (isNotFoundError(err)) {
          currentJobStatus = "cancelled";
          upsertConfirmCard(id, "cancelled");
          setConnectionStatus("历史任务已过期（服务端可能已重启），请重新提交");
        } else {
          setConnectionStatus(formatErrorMessage(config.serverUrl, err));
        }
      }
    },
    onPlanReply: async (id, reply) => {
      const config = await loadConfig();
      if (!config.serverUrl) return;
      try {
        resetPlanOutputBuffer(id);
        currentJobStatus = "planning";
        upsertConfirmCard(id, "planning");
        setConnectionStatus("正在根据补充说明继续分析...");
        await replyToPlan(config.serverUrl, id, reply);
      } catch (err) {
        setConnectionStatus(formatErrorMessage(config.serverUrl, err));
        upsertConfirmCard(id, currentJobStatus ?? "awaiting_input");
      }
    },
    onCancel: async (id) => {
      const config = await loadConfig();
      if (!config.serverUrl) return;
      try {
        await cancelJob(config.serverUrl, id);
        currentJobStatus = "cancelled";
        upsertConfirmCard(id, "cancelled");
        setConnectionStatus("任务已取消");
      } catch (err) {
        if (isNotFoundError(err)) {
          currentJobStatus = "cancelled";
          upsertConfirmCard(id, "cancelled");
          setConnectionStatus("历史任务已过期（服务端可能已重启），无需操作");
        } else {
          setConnectionStatus(formatErrorMessage(config.serverUrl, err));
        }
      }
    },
  });
  moveMessageToBottom(`${CONFIRM_CARD_KEY}-${jobId}`);
}

function mergeCardStatusLabel(status: JobStatusType): string {
  switch (status) {
    case "awaiting_merge":
      return "";
    case "running":
      return createMergeRequestOnMerge ? "正在提交 Merge Request..." : "正在合并到 test...";
    case "completed":
      return createMergeRequestOnMerge ? "已提交 Merge Request" : "已合并到 test";
    case "cancelled":
      return "已放弃合并";
    case "failed":
      return "合并失败";
    default:
      return "不可操作";
  }
}

function upsertMergeConfirmCard(
  jobId: string,
  status: JobStatusType = currentJobStatus ?? "awaiting_merge",
  previewUrl?: string,
  previewMessage?: string
): void {
  if (previewUrl) previewUrls.set(jobId, previewUrl);
  if (previewMessage) previewMessages.set(jobId, previewMessage);
  const node = ensureMessageElement(`${MERGE_CARD_KEY}-${jobId}`, "msg msg-queue");
  const readonly = status !== "awaiting_merge";
  const statusLabel = mergeCardStatusLabel(status);
  const confirmTitle = createMergeRequestOnMerge
    ? "修改已完成：是否提交 Merge Request？"
    : "修改已完成：是否合并到 test？";
  const actionTitle = createMergeRequestOnMerge
    ? "修改已完成：是否提交 Merge Request？"
    : "修改已完成：是否合并到 test 并提交？";
  const actionLabel = createMergeRequestOnMerge ? "提交 Merge Request" : "合并到 test";
  const hint = createMergeRequestOnMerge
    ? "提交后会推送 feature 分支并创建 Merge Request，test 代码不做直接改动"
    : "放弃后将切回 test 分支，test 代码不做任何改动";
  const effectivePreviewUrl = previewUrls.get(jobId);
  const previewHtml = effectivePreviewUrl
    ? `<div class="hint" style="margin-top:8px;">预览地址：<a href="${escapeHtml(effectivePreviewUrl)}" target="_blank" rel="noreferrer">${escapeHtml(effectivePreviewUrl)}</a></div>`
    : previewMessages.get(jobId)
      ? `<div class="hint" style="margin-top:8px;">预览状态：${escapeHtml(previewMessages.get(jobId)!)}</div>`
      : "";

  if (readonly) {
    node.innerHTML = `
      <div class="msg-meta">合并确认</div>
      <div class="queue-card">
        <div class="queue-title">${confirmTitle}</div>
        ${previewHtml}
        <div class="confirm-status">${escapeHtml(statusLabel)}</div>
      </div>
    `;
    moveMessageToBottom(`${MERGE_CARD_KEY}-${jobId}`);
    return;
  }

  node.innerHTML = `
    <div class="msg-meta">等待确认合并</div>
    <div class="queue-card">
      <div class="queue-title">${actionTitle}</div>
      <div class="confirm-actions">
        <button class="primary" data-action="merge">${actionLabel}</button>
        <button class="secondary" data-action="discard">放弃</button>
      </div>
      ${previewHtml}
      <div class="hint" style="margin-top:8px;">${hint}</div>
    </div>
  `;
  moveMessageToBottom(`${MERGE_CARD_KEY}-${jobId}`);

  const mergeBtn = node.querySelector<HTMLButtonElement>('button[data-action="merge"]');
  const discardBtn = node.querySelector<HTMLButtonElement>('button[data-action="discard"]');
  if (mergeBtn) {
    mergeBtn.onclick = async () => {
      const config = await loadConfig();
      if (!config.serverUrl) return;
      createMergeRequestOnMerge = config.createMergeRequestOnMerge;
      try {
        mergeBtn.disabled = true;
        discardBtn!.disabled = true;
        setConnectionStatus(createMergeRequestOnMerge ? "已确认提交 Merge Request，正在处理..." : "已确认合并，正在处理...");
        await mergeJob(config.serverUrl, jobId, { createMergeRequest: createMergeRequestOnMerge });
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

function upsertAgentStatus(event: JobEvent): void {
  const text = event.statusText ?? event.text;
  if (!text) return;

  const node = ensureMessageElement(`${AGENT_STATUS_KEY}-${event.jobId}`, "msg msg-tool");
  node.innerHTML = `<div class="tool-line">${escapeHtml(text)}</div>`;
  setConnectionStatus(text);
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

function linkifyText(text: string): string {
  const escaped = escapeHtml(text);
  return escaped.replace(/https?:\/\/[^\s<]+/g, (url) => {
    const href = url.replace(/[),.;]+$/, "");
    const suffix = url.slice(href.length);
    return `<a href="${href}" target="_blank" rel="noreferrer">${href}</a>${suffix}`;
  });
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

function handleJobEvent(event: JobEvent, options?: { skipPersist?: boolean }): void {
  if (seenEventIds.has(event.id)) return;
  seenEventIds.add(event.id);
  lastEventAt = Date.now();
  if (event.previewUrl) previewUrls.set(event.jobId, event.previewUrl);
  if (event.previewMessage) previewMessages.set(event.jobId, event.previewMessage);

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
        void hydratePlanSummaryFromServer(event.jobId).finally(() => {
          flushPlanResultBubble(event.jobId, undefined, true);
          currentJobStatus = "awaiting_confirm";
          upsertConfirmCard(event.jobId, "awaiting_confirm");
          setConnectionStatus("等待确认执行");
          updateSubmitButton();
        });
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
        upsertMergeConfirmCard(event.jobId, "awaiting_merge", event.previewUrl, event.previewMessage);
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
      } else if (event.phase === "merge_request") {
        currentJobStatus = "running";
        upsertMergeConfirmCard(event.jobId, "running");
        setConnectionStatus("正在提交 Merge Request");
        updateSubmitButton();
      } else if (event.phase === "release_merge_done" || event.phase === "default_revert_done") {
        refreshTaskDrawer();
      } else if (event.phase && ["pull", "branch", "agent", "commit"].includes(event.phase)) {
        currentJobStatus = "running";
        setConnectionStatus("执行中");
        updateSubmitButton();
      } else if (event.phase === "plan") {
        resetPlanOutputBuffer(event.jobId);
        currentJobStatus = "planning";
        upsertConfirmCard(event.jobId, "planning");
        setConnectionStatus("Plan 分析中");
        updateSubmitButton();
      }
      break;
    case "agent_text":
      if (event.delta) appendAgentDelta(event.delta, event.jobId);
      break;
    case "agent_status":
      upsertAgentStatus(event);
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
      refreshTaskDrawer();
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
      refreshTaskDrawer();
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
      refreshTaskDrawer();
      break;
  }

  if (!options?.skipPersist) {
    persistJobEvent(event);
  }

  scrollChatToBottom();
}

function connectJobStream(serverUrl: string, jobId: string, initialStatus?: JobStatusType): void {
  activeStream?.close();
  activeJobId = jobId;
  if (initialStatus) currentJobStatus = initialStatus;
  resetJobRecovery();
  setConnectionStatus("加载任务记录…");
  lastEventAt = Date.now();

  activeStream = openJobEventStream(serverUrl, jobId, handleJobEvent, {
    onOpen: () => {
      recoveryFailureCount = 0;
      if (currentJobStatus) {
        applyHeaderStatusFromJob({ jobId, status: currentJobStatus, createdAt: "", updatedAt: "" });
      } else {
        setConnectionStatus("已连接");
      }
      updateSubmitButton();
    },
    onError: () => {
      if (recoveryStopped || isTerminalStatus(currentJobStatus)) return;

      const quietMs = Date.now() - lastEventAt;
      if (quietMs > 3000) {
        setConnectionStatus(
          recoveryFailureCount > 0
            ? `连接中断，正在重试（${recoveryFailureCount}/${MAX_RECOVERY_FAILURES}）…`
            : "连接中断，正在尝试恢复…"
        );
      }

      if (
        quietMs > RECOVER_QUIET_MS &&
        activeJobId === jobId &&
        !isTerminalStatus(currentJobStatus) &&
        currentJobStatus !== "awaiting_confirm" &&
        currentJobStatus !== "awaiting_input" &&
        currentJobStatus !== "awaiting_merge"
      ) {
        void recoverJobConnection(serverUrl, jobId);
      } else if (
        activeJobId === jobId &&
        !isTerminalStatus(currentJobStatus) &&
        currentJobStatus !== "awaiting_confirm" &&
        currentJobStatus !== "awaiting_input" &&
        currentJobStatus !== "awaiting_merge"
      ) {
        scheduleJobRecovery(serverUrl, jobId, RECOVER_QUIET_MS - quietMs);
      }
    },
    onClose: () => {
      if (
        recoveryStopped ||
        activeJobId !== jobId ||
        isTerminalStatus(currentJobStatus) ||
        currentJobStatus === "awaiting_confirm" ||
        currentJobStatus === "awaiting_input" ||
        currentJobStatus === "awaiting_merge"
      ) {
        if (activeStream && currentJobStatus) {
          applyHeaderStatusFromJob({ jobId, status: currentJobStatus, createdAt: "", updatedAt: "" });
        }
        return;
      }

      setConnectionStatus("连接中断，正在尝试恢复…");
      void recoverJobConnection(serverUrl, jobId);
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

let releaseMergeResolver: ((targetBranch: string | null) => void) | null = null;

function closeReleaseMergeModal(targetBranch: string | null): void {
  const modal = document.getElementById("releaseMergeModal");
  if (modal) modal.hidden = true;
  const resolver = releaseMergeResolver;
  releaseMergeResolver = null;
  resolver?.(targetBranch);
}

async function showReleaseMergeModal(job: JobStatus, branches: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const modal = el<HTMLElement>("releaseMergeModal");
    const titleEl = el<HTMLElement>("releaseMergeTitle");
    const sourceEl = el<HTMLElement>("releaseMergeSource");
    const selectEl = el<HTMLSelectElement>("releaseMergeBranch");
    const hintEl = el<HTMLElement>("releaseMergeHint");
    const okBtn = el<HTMLButtonElement>("releaseMergeOk");

    releaseMergeResolver = resolve;
    titleEl.textContent = job.message?.split("\n")[0]?.trim() || job.jobId;
    sourceEl.textContent = job.sourceBranch ?? "";

    selectEl.innerHTML = branches.length
      ? branches.map((branch) => `<option value="${escapeHtml(branch)}">${escapeHtml(branch)}</option>`).join("")
      : `<option value="">暂无可选分支</option>`;
    selectEl.disabled = branches.length === 0;
    okBtn.disabled = branches.length === 0;
    hintEl.textContent = branches.length === 0
      ? "没有可合并的远程分支，或可选分支已全部合并。"
      : "将只合并本次改动分支，不会把 test 上其他提交一起带过去。";

    modal.hidden = false;
    if (branches.length > 0) {
      selectEl.focus();
    } else {
      el<HTMLButtonElement>("releaseMergeCancel").focus();
    }
  });
}

function setupReleaseMergeModal(): void {
  el<HTMLButtonElement>("releaseMergeOk").addEventListener("click", () => {
    const branch = el<HTMLSelectElement>("releaseMergeBranch").value;
    closeReleaseMergeModal(branch || null);
  });
  el<HTMLButtonElement>("releaseMergeCancel").addEventListener("click", () => {
    closeReleaseMergeModal(null);
  });
  el<HTMLElement>("releaseMergeBackdrop").addEventListener("click", () => {
    closeReleaseMergeModal(null);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const modal = document.getElementById("releaseMergeModal");
    if (modal && !modal.hidden) {
      closeReleaseMergeModal(null);
    }
  });
}

async function handleReleaseMerge(job: JobStatus): Promise<void> {
  const config = await loadConfig();
  if (!config.serverUrl) {
    setConnectionStatus("请先在设置中配置服务端地址");
    return;
  }

  try {
    setConnectionStatus("正在加载远程分支...");
    const branches = await fetchReleaseBranches(config.serverUrl, job.jobId);
    const targetBranch = await showReleaseMergeModal(job, branches);
    if (!targetBranch) {
      setConnectionStatus("已取消发版分支合并");
      return;
    }

    setConnectionStatus(`正在合并到 ${targetBranch}...`);
    await mergeJobToReleaseBranch(config.serverUrl, job.jobId, targetBranch);
    setConnectionStatus(`已合并到 ${targetBranch}`);
    refreshTaskDrawer();
  } catch (err) {
    setConnectionStatus(formatErrorMessage(config.serverUrl, err));
    refreshTaskDrawer();
  }
}

let revertDefaultResolver: ((confirmed: boolean) => void) | null = null;

function closeRevertDefaultModal(confirmed: boolean): void {
  const modal = document.getElementById("revertDefaultModal");
  if (modal) modal.hidden = true;
  const resolver = revertDefaultResolver;
  revertDefaultResolver = null;
  resolver?.(confirmed);
}

function showRevertDefaultModal(job: JobStatus): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = el<HTMLElement>("revertDefaultModal");
    const titleEl = el<HTMLElement>("revertDefaultTitle");
    const commitEl = el<HTMLElement>("revertDefaultCommit");

    revertDefaultResolver = resolve;
    titleEl.textContent = job.message?.split("\n")[0]?.trim() || job.jobId;
    commitEl.textContent = job.commitSha ?? "";
    modal.hidden = false;
    el<HTMLButtonElement>("revertDefaultCancel").focus();
  });
}

function setupRevertDefaultModal(): void {
  el<HTMLButtonElement>("revertDefaultOk").addEventListener("click", () => {
    closeRevertDefaultModal(true);
  });
  el<HTMLButtonElement>("revertDefaultCancel").addEventListener("click", () => {
    closeRevertDefaultModal(false);
  });
  el<HTMLElement>("revertDefaultBackdrop").addEventListener("click", () => {
    closeRevertDefaultModal(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const modal = document.getElementById("revertDefaultModal");
    if (modal && !modal.hidden) {
      closeRevertDefaultModal(false);
    }
  });
}

async function handleRevertDefault(job: JobStatus): Promise<void> {
  const config = await loadConfig();
  if (!config.serverUrl) {
    setConnectionStatus("请先在设置中配置服务端地址");
    return;
  }

  const confirmed = await showRevertDefaultModal(job);
  if (!confirmed) {
    setConnectionStatus("已取消撤回");
    return;
  }

  try {
    setConnectionStatus("正在撤回 test 提交...");
    await revertJobFromDefaultBranch(config.serverUrl, job.jobId);
    setConnectionStatus("test 已撤回本次改动");
    refreshTaskDrawer();
  } catch (err) {
    setConnectionStatus(formatErrorMessage(config.serverUrl, err));
    refreshTaskDrawer();
  }
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

  await flushPendingServerCancel(config.serverUrl);

  const pageContext = await fetchPageContext(includeContext);
  if (pageContext) {
    renderPagePreview(pageContext.url, pageContext.title);
  }

  const confirmed = await showPageConfirmModal(pageContext);
  if (!confirmed) {
    setConnectionStatus("已取消发送");
    return;
  }

  const savedTask = await saveCodingPromptAsTask({
    prompt,
    pageUrl: pageContext?.url,
    pageTitle: pageContext?.title,
  });
  refreshTaskDrawer();

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
    await attachJobToCodingTask(savedTask.id, data.jobId);
    refreshTaskDrawer();
    await initCodingJobSession(data.jobId, data.status as JobStatusType);
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

let batchPanelReady = false;

function switchAppView(view: "coding" | "batch"): void {
  const codingView = el<HTMLElement>("codingView");
  const batchPanel = el<HTMLElement>("tapdBatchPanel");
  const batchBtn = el<HTMLButtonElement>("tapdBatchBtn");

  codingView.hidden = view !== "coding";
  batchPanel.hidden = view !== "batch";
  batchBtn.classList.toggle("icon-btn-active", view === "batch");

  if (view === "batch" && !batchPanelReady) {
    initTapdBatchPanel(batchPanel, { onBack: () => switchAppView("coding") });
    batchPanelReady = true;
  }
}

async function init(): Promise<void> {
  const config = await loadConfig();
  createMergeRequestOnMerge = config.createMergeRequestOnMerge;

  await refreshPagePreview();

  el<HTMLElement>("settingsBtn").addEventListener("click", () => {
    window.location.href = chrome.runtime.getURL("settings.html");
  });
  el<HTMLButtonElement>("tapdBatchBtn").addEventListener("click", () => {
    switchAppView("batch");
  });
  initCodingTaskPicker({
    onSelect: (task) => {
      el<HTMLTextAreaElement>("prompt").value = task.draftPrompt;
      setConnectionStatus(`已载入任务：${task.title}`);
    },
    onReleaseMerge: handleReleaseMerge,
    onRevertDefault: handleRevertDefault,
    onStatus: setConnectionStatus,
  });
  el<HTMLElement>("refreshPageBtn").addEventListener("click", refreshPagePreview);
  el<HTMLButtonElement>("submitBtn").addEventListener("click", handleSubmit);
  setupAttachmentHandlers();
  setupComposerResize();
  setupChatContextMenu();
  setupPageConfirmModal();
  setupReleaseMergeModal();
  setupRevertDefaultModal();

  el<HTMLTextAreaElement>("prompt").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSubmit();
    }
  });

  window.addEventListener("focus", () => {
    void refreshPagePreview();
    void loadConfig().then((cfg) => {
      createMergeRequestOnMerge = cfg.createMergeRequestOnMerge;
      if (cfg.serverUrl) void tryFlushPendingServerCancel(cfg.serverUrl);
    });
  });
  updateSubmitButton();

  if (config.serverUrl) {
    void tryFlushPendingServerCancel(config.serverUrl);
    void ensurePendingCancelRetry(config.serverUrl);
  }

  const session = await restoreChatFromSession();
  const jobId = session?.jobId ?? (await chrome.storage.local.get(["lastJobId"])).lastJobId as string | undefined;

  if (!jobId || !config.serverUrl) {
    if (session?.status) {
      applyHeaderStatusFromJob({
        jobId: session.jobId,
        status: session.status,
        createdAt: session.updatedAt,
        updatedAt: session.updatedAt,
      });
      updateSubmitButton();
    }
    return;
  }

  try {
    const job = await queryJobStatus(config.serverUrl, jobId);

    if (isServerRestartedJob(job)) {
      dismissStaleJob(session?.status ?? "cancelled");
      return;
    }

    if (job.status === "pending") {
      dismissStaleJob("cancelled");
      setConnectionStatus("连接已断开，排队任务已失效，请重新提交");
      return;
    }

    await syncMissedJobEvents(config.serverUrl, job.jobId);
    applyServerJobState(job);

    if (isTerminalStatus(job.status)) {
      applyHeaderStatusFromJob(job);
      updateSubmitButton();
      return;
    }

    if (isStaticRecoverableStatus(job.status)) {
      activeJobId = job.jobId;
      await chrome.storage.local.set({ lastJobId: job.jobId });
      updateSubmitButton();
      return;
    }

    if (isStreamRecoverableStatus(job.status)) {
      activeJobId = job.jobId;
      await chrome.storage.local.set({ lastJobId: job.jobId });
      connectJobStream(config.serverUrl, job.jobId, job.status);
      return;
    }

    dismissStaleJob(session?.status);
  } catch (err) {
    if (isNotFoundError(err)) {
      dismissStaleJob(session?.status);
      return;
    }
    void chrome.storage.local.remove(["lastJobId"]);
    setConnectionStatus(formatErrorMessage(config.serverUrl, err));
  }

  if (location.hash === "#batch") {
    switchAppView("batch");
  }
}

init();
