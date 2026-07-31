import "../shared/styles.css";
import "../shared/shellView.css";
import { loadConfig, saveConfig } from "../shared/config.js";
import {
  fetchConversationContextStats,
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
  listJobs,
  queryJobStatus,
  queryJobStatusWithRetry,
  submitPlan,
  submitQuestion,
} from "../shared/api.js";
import type {
  JobEvent,
  JobStatus,
  JobStatusType,
  PageContext,
  SubmitRequest,
  TapdContext,
  TapdIteration,
  TapdWorkspace,
} from "../shared/types.js";
import {
  MAX_ATTACHMENTS,
  HARD_MAX_BYTES,
  compressImageForUpload,
  formatBytes,
} from "../shared/imageCompress.js";
import { initCodingTaskPicker, refreshTaskDrawer } from "./codingTaskPicker.js";
import { setupComposerResize } from "./composerResize.js";
import { setupSidebarResize } from "./sidebarResize.js";
import {
  attachConversationToCodingTask,
  attachJobToCodingTask,
  listCodingTasks,
  saveCodingPromptAsTask,
} from "../shared/codingTaskStore.js";
import {
  addExistingConversation,
  addJobToCodingConversation,
  createCodingConversation,
  getActiveCodingConversation,
  getCodingConversation,
  setCodingConversationTapdContext,
  setActiveCodingConversation,
} from "../shared/codingConversationStore.js";
import {
  createTapdBug,
  fetchTapdIterations,
  fetchTapdWorkspaces,
  resolveTapdContext,
} from "../shared/tapdApi.js";
import {
  prepareTapdJobImages,
  type PrepareTapdImagesResult,
} from "../shared/tapdJobImages.js";
import { mountPlanConfirmCard } from "../shared/planConfirmCard.js";
import { enhanceSelects, refreshCustomSelect } from "../shared/customSelect.js";
import {
  appendCodingJobEvent,
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
const AGENT_PROGRESS_KEY = "agent-progress";
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
let progressIdleTimer: ReturnType<typeof setInterval> | null = null;
let lastProgressNoticeAt = 0;
const MAX_RECOVERY_FAILURES = 3;
const RECOVER_QUIET_MS = 12_000;
const PROGRESS_IDLE_NOTICE_MS = 30_000;
const RECOVER_RETRY_GAP_MS = 8_000;
const PENDING_CANCEL_RETRY_MS = 10_000;

let pendingCancelRetryTimer: ReturnType<typeof setInterval> | null = null;
let lastLocalUserBubble:
  | { localId: string; text: string; pageUrl?: string; createdAtMs: number; imageUrls?: string[] }
  | null = null;
const pendingAttachments: PendingAttachment[] = [];
const previewUrls = new Map<string, string>();
const previewMessages = new Map<string, string>();
const mergeRetryableJobs = new Map<string, boolean>();
let planOutputBuffer = "";
let planOutputJobId: string | null = null;
let createMergeRequestOnMerge = false;
let submitInFlight = false;
let activeConversationId = "";
let activeTapdContext: TapdContext | null = null;
let mentionTriggerIndex: number | null = null;
let tapdContextLoading = false;
let tapdImageCache:
  | {
      contextKey: string;
      result: PrepareTapdImagesResult;
      previewUrls: Map<number, string>;
    }
  | null = null;

function startActionAlert(title: string): void {
  chrome.runtime
    .sendMessage({ type: "ACTION_ALERT_START", title })
    .catch(() => {});
}

function stopActionAlert(): void {
  chrome.runtime.sendMessage({ type: "ACTION_ALERT_STOP" }).catch(() => {});
}

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
  scrollChatToBottom();
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
  scrollChatToBottom();
}

function removeMessageByKey(key: string): void {
  el<HTMLElement>("chatMessages").querySelector<HTMLElement>(`[data-key="${key}"]`)?.remove();
}

function hasExistingGateCard(jobId: string): boolean {
  const container = el<HTMLElement>("chatMessages");
  return Boolean(
    container.querySelector(`[data-key="${CONFIRM_CARD_KEY}-${jobId}"]`) ||
    container.querySelector(`[data-key="${MERGE_CARD_KEY}-${jobId}"]`)
  );
}

function updateExistingGateCards(jobId: string, status: JobStatusType): void {
  const container = el<HTMLElement>("chatMessages");
  if (container.querySelector(`[data-key="${CONFIRM_CARD_KEY}-${jobId}"]`)) {
    upsertConfirmCard(jobId, status);
  }
  if (container.querySelector(`[data-key="${MERGE_CARD_KEY}-${jobId}"]`)) {
    upsertMergeConfirmCard(jobId, status);
  }
}

function isCancellableStatus(status: JobStatusType | null): boolean {
  return status === "planning" || status === "pending" || status === "running";
}

function updateSubmitButton(): void {
  const btn = el<HTMLButtonElement>("submitBtn");
  const cancellable = isCancellableStatus(currentJobStatus);
  const hasPrompt = Boolean(el<HTMLTextAreaElement>("prompt").value.trim());
  btn.textContent = cancellable ? "取消" : "回车发送";
  btn.classList.toggle("danger", cancellable);
  btn.disabled = submitInFlight || (!cancellable && !hasPrompt);
}

function formatContextTitle(
  usedJobs: number,
  maxJobs: number,
  usedChars: number,
  maxChars: number
): string {
  return `会话上下文：${usedJobs.toLocaleString("zh-CN")} / ${maxJobs.toLocaleString("zh-CN")} 轮，${usedChars.toLocaleString("zh-CN")} / ${maxChars.toLocaleString("zh-CN")} 字`;
}

async function refreshSubmitButtonContextTitle(serverUrl?: string): Promise<void> {
  const conversationId = activeConversationId;
  const button = el<HTMLButtonElement>("submitBtn");
  button.dataset.contextTitle = formatContextTitle(0, 10, 0, 16_000);
  if (!conversationId) return;

  const resolvedServerUrl = serverUrl ?? (await loadConfig()).serverUrl;
  if (!resolvedServerUrl) return;

  try {
    const stats = await fetchConversationContextStats(resolvedServerUrl, conversationId);
    if (activeConversationId !== conversationId) return;
    button.dataset.contextTitle = formatContextTitle(
      stats.usedJobs,
      stats.maxJobs,
      stats.usedChars,
      stats.maxChars
    );
  } catch {
    // 服务暂不可用时保留默认额度提示，不影响发送。
  }
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
  stopProgressIdleNotice();
  activeStream?.close();
  activeStream = null;
}

function isWaitingForUserStatus(status: JobStatusType | null): boolean {
  return status === "awaiting_confirm" || status === "awaiting_input" || status === "awaiting_merge";
}

function stopProgressIdleNotice(): void {
  if (!progressIdleTimer) return;
  clearInterval(progressIdleTimer);
  progressIdleTimer = null;
}

function startProgressIdleNotice(jobId: string): void {
  stopProgressIdleNotice();
  lastProgressNoticeAt = Date.now();
  progressIdleTimer = setInterval(() => {
    if (
      activeJobId !== jobId ||
      isTerminalStatus(currentJobStatus) ||
      isWaitingForUserStatus(currentJobStatus)
    ) {
      stopProgressIdleNotice();
      return;
    }

    const quietMs = Date.now() - lastEventAt;
    const sinceNoticeMs = Date.now() - lastProgressNoticeAt;
    if (quietMs < PROGRESS_IDLE_NOTICE_MS || sinceNoticeMs < PROGRESS_IDLE_NOTICE_MS) return;

    const seconds = Math.max(30, Math.round(quietMs / 1000));
    const text = `仍在处理中，已等待 ${seconds} 秒，可能正在等待响应或执行耗时操作...`;
    upsertProgressCard(jobId, text);
    setConnectionStatus(text);
    lastProgressNoticeAt = Date.now();
  }, 5000);
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

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function scrollChatToBottom(): void {
  const main = el<HTMLElement>("chatMain");
  const scroll = (): void => {
    main.scrollTop = main.scrollHeight;
  };
  requestAnimationFrame(() => {
    scroll();
    requestAnimationFrame(scroll);
  });
  window.setTimeout(scroll, 120);
}

function clearChatDom(): void {
  el<HTMLElement>("chatMessages").innerHTML = "";
  seenEventIds.clear();
  lastLocalUserBubble = null;
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

async function migrateLegacyTaskConversations(): Promise<void> {
  const tasks = await listCodingTasks();
  for (const task of tasks) {
    if (task.conversationId) continue;
    const conversation = await addExistingConversation({
      title: task.title || task.draftPrompt || "历史任务",
      jobId: task.jobId,
    });
    await attachConversationToCodingTask(task.id, conversation.id);
  }
}

function detachConversationView(): void {
  stopJobRecovery();
  activeStream?.close();
  activeStream = null;
  activeJobId = null;
  currentJobStatus = null;
  resetPlanOutputBuffer(null);
}

async function openCodingConversation(
  conversationId: string,
  anchorJobId?: string
): Promise<void> {
  const conversation = await getCodingConversation(conversationId);
  if (!conversation) return;

  detachConversationView();
  clearChatDom();
  activeConversationId = conversation.id;
  activeTapdContext = conversation.tapdContext ?? null;
  renderTapdContext();
  await setActiveCodingConversation(conversation.id);
  refreshTaskDrawer();

  const config = await loadConfig();
  void refreshSubmitButtonContextTitle(config.serverUrl);
  if (
    config.serverUrl &&
    activeTapdContext?.sourceHtml &&
    (activeTapdContext.imageCount ?? 0) > 0
  ) {
    const contextBeingLoaded = activeTapdContext;
    void prepareTapdContextImages(config.serverUrl, contextBeingLoaded).then(() => {
      if (
        activeConversationId === conversation.id &&
        activeTapdContext &&
        tapdContextKey(activeTapdContext) === tapdContextKey(contextBeingLoaded)
      ) {
        renderTapdContext();
      }
    });
  }
  if (!config.serverUrl || conversation.jobIds.length === 0) {
    setConnectionStatus(conversation.jobIds.length === 0 ? "新会话" : "请先配置服务端地址");
    updateSubmitButton();
    return;
  }

  try {
    const jobs = await listJobs(config.serverUrl);
    const jobsById = new Map(jobs.map((job) => [job.jobId, job]));
    const visibleJobs = conversation.jobIds
      .map((jobId) => jobsById.get(jobId))
      .filter((job): job is JobStatus => Boolean(job));

    if (visibleJobs.length === 0) {
      const session = await getCodingJobSession();
      if (session && conversation.jobIds.includes(session.jobId)) {
        await restoreChatFromSession();
      } else {
        setConnectionStatus("会话任务已过期（服务端可能已重启）");
      }
      updateSubmitButton();
      return;
    }

    for (const job of visibleJobs) {
      currentJobStatus = job.status;
      resetPlanOutputBuffer(job.jobId);
      const events = await fetchJobEvents(config.serverUrl, job.jobId);
      for (const event of events) {
        handleJobEvent(event, {
          skipPersist: true,
          allowOtherJobs: true,
          replay: true,
        });
      }
      applyServerJobState(job);
    }

    const latestJob = visibleJobs[visibleJobs.length - 1];
    activeJobId = latestJob.jobId;
    currentJobStatus = latestJob.status;
    applyHeaderStatusFromJob(latestJob);
    await initCodingJobSession(latestJob.jobId, latestJob.status);
    await chrome.storage.local.set({ lastJobId: latestJob.jobId });

    if (isStreamRecoverableStatus(latestJob.status)) {
      connectJobStream(config.serverUrl, latestJob.jobId, latestJob.status);
    } else {
      updateSubmitButton();
    }

    if (anchorJobId) {
      requestAnimationFrame(() => {
        el<HTMLElement>("chatMessages")
          .querySelector<HTMLElement>(`[data-job-id="${anchorJobId}"]`)
          ?.scrollIntoView({ block: "center" });
      });
    } else {
      scrollChatToBottom();
    }
  } catch (err) {
    setConnectionStatus(formatErrorMessage(config.serverUrl, err));
    updateSubmitButton();
  }
}

async function createAndOpenConversation(): Promise<void> {
  const conversation = await createCodingConversation();
  el<HTMLTextAreaElement>("prompt").value = "";
  await openCodingConversation(conversation.id);
  el<HTMLTextAreaElement>("prompt").focus();
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

function setConnectionStatus(text: string): void {
  el<HTMLElement>("connectionStatus").textContent = text;
}

function applyHeaderStatusFromJob(job: JobStatus): void {
  const labels: Record<JobStatusType, string> = {
    planning: "Plan 分析中",
    awaiting_confirm: "等待确认执行",
    awaiting_merge: "等待确认合并",
    awaiting_input: "需要补充信息",
    pending: job.jobsAhead ? `排队中，前面 ${job.jobsAhead} 个任务` : "准备执行",
    running: job.requiresConfirm ? "执行中" : "项目分析中",
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
      return "已确认，准备执行";
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
    upsertMergeConfirmCard(
      job.jobId,
      "awaiting_merge",
      job.previewUrl,
      job.previewMessage,
      job.mergeRetryable
    );
    setConnectionStatus(job.mergeRetryable ? "等待重试合并" : "等待确认合并");
    updateSubmitButton();
    return;
  }

  if (job.status === "planning") {
    setConnectionStatus("Plan 分析中…");
    updateSubmitButton();
    return;
  }

  if (job.status === "pending" || job.status === "running") {
    setConnectionStatus(job.status === "running" ? "执行中" : "准备执行");
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
  node.dataset.jobId = event.jobId;
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
      localNode.dataset.jobId = event.jobId;
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
    node.dataset.jobId = event.jobId;
    return true;
  }
  return false;
}

function updateQueueCard(event: JobEvent): void {
  const node = ensureMessageElement(`${QUEUE_CARD_KEY}-${event.jobId}`, "msg msg-queue");
  const running = event.running;
  const waiting = event.waiting ?? [];
  const stateClass = running ? "queue-card--running" : "queue-card--waiting";

  const runningHtml = running
    ? `<li class="queue-running"><span>执行中</span> ${escapeHtml(running.prompt)}</li>`
    : "";

  const waitingHtml = waiting
    .map((item) => `<li><span>#${item.jobsAhead}</span> ${escapeHtml(item.prompt)}</li>`)
    .join("");

  node.innerHTML = `
    <div class="msg-meta">${formatTime(event.timestamp)} · 任务队列</div>
    <div class="queue-card ${stateClass}">
      <div class="queue-title">${escapeHtml(event.text ?? "")}</div>
      <ul class="queue-list">${runningHtml}${waitingHtml}</ul>
    </div>
  `;
}

function stageStateClass(event: JobEvent): string {
  if (event.phase === "release_merge_done" || event.phase === "default_revert_done") {
    return "msg-stage--success";
  }
  if (
    event.phase === "plan_done" ||
    event.phase === "plan_need_more" ||
    event.phase === "execute_ready" ||
    event.phase === "merge_retryable"
  ) {
    return "msg-stage--waiting";
  }
  return "msg-stage--running";
}

function appendStageBubble(event: JobEvent): void {
  const node = document.createElement("div");
  node.className = `msg msg-stage ${stageStateClass(event)}`;
  node.dataset.key = event.id;
  node.innerHTML = `
    <time class="stage-time">${formatTime(event.timestamp)}</time>
    <div class="stage-bubble">
      <span class="stage-marker" aria-hidden="true"></span>
      <div class="stage-text">${linkifyText(event.text ?? "")}</div>
    </div>
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
        setConnectionStatus("已确认执行，正在准备独立工作区...");
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

function gateStatusTone(status: JobStatusType): string {
  switch (status) {
    case "completed":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    case "awaiting_confirm":
    case "awaiting_input":
    case "awaiting_merge":
      return "waiting";
    default:
      return "running";
  }
}

function gateStatusIcon(status: JobStatusType): string {
  switch (status) {
    case "completed":
      return "✓";
    case "failed":
      return "!";
    case "cancelled":
      return "";
    default:
      return "●";
  }
}

function upsertMergeConfirmCard(
  jobId: string,
  status: JobStatusType = currentJobStatus ?? "awaiting_merge",
  previewUrl?: string,
  previewMessage?: string,
  mergeRetryable?: boolean
): void {
  if (previewUrl) previewUrls.set(jobId, previewUrl);
  if (previewMessage) previewMessages.set(jobId, previewMessage);
  if (mergeRetryable !== undefined) mergeRetryableJobs.set(jobId, mergeRetryable);
  const node = ensureMessageElement(`${MERGE_CARD_KEY}-${jobId}`, "msg msg-queue");
  const readonly = status !== "awaiting_merge";
  const statusLabel = mergeCardStatusLabel(status);
  const retryable = mergeRetryableJobs.get(jobId) === true;
  const useMergeRequest = !retryable && createMergeRequestOnMerge;
  const actionTitle = retryable
    ? "Git 仓库暂时无法访问，代码修改和任务分支已保留"
    : useMergeRequest
      ? "修改已完成：是否提交 Merge Request？"
      : "修改已完成：是否合并到 test 并提交？";
  const actionLabel = retryable ? "重试合并到 test" : useMergeRequest ? "提交 Merge Request" : "合并到 test";
  const hint = retryable
    ? "重试只会重新执行 Git 合并和推送，不会重新运行 AI 修改代码"
    : useMergeRequest
      ? "提交后会推送 feature 分支并创建 Merge Request，test 代码不做直接改动"
      : "放弃后将切回 test 分支，test 代码不做任何改动";
  const effectivePreviewUrl = previewUrls.get(jobId);
  const previewHtml = effectivePreviewUrl
    ? `<div class="hint" style="margin-top:8px;">预览地址：<a href="${escapeHtml(effectivePreviewUrl)}" target="_blank" rel="noreferrer">${escapeHtml(effectivePreviewUrl)}</a></div>`
    : previewMessages.get(jobId)
      ? `<div class="hint" style="margin-top:8px;">预览状态：${escapeHtml(previewMessages.get(jobId)!)}</div>`
      : "";

  if (readonly) {
    const icon = gateStatusIcon(status);
    node.innerHTML = `
      <div class="result-card result-card--${gateStatusTone(status)}">
        ${icon ? `<span class="result-icon" aria-hidden="true">${icon}</span>` : ""}
        <div class="result-content">
          <div class="result-title">${escapeHtml(statusLabel)}</div>
          ${previewHtml ? `<div class="result-detail">${previewHtml}</div>` : ""}
        </div>
      </div>
    `;
    moveMessageToBottom(`${MERGE_CARD_KEY}-${jobId}`);
    return;
  }

  node.innerHTML = `
    <div class="msg-meta">${retryable ? "等待重试合并" : "等待确认合并"}</div>
    <div class="queue-card queue-card--waiting queue-card--confirm">
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
      const shouldCreateMergeRequest = retryable ? false : createMergeRequestOnMerge;
      try {
        mergeBtn.disabled = true;
        discardBtn!.disabled = true;
        setConnectionStatus(retryable
          ? "正在重试合并到 test..."
          : shouldCreateMergeRequest
            ? "已确认提交 Merge Request，正在处理..."
            : "已确认合并，正在处理...");
        await mergeJob(config.serverUrl, jobId, { createMergeRequest: shouldCreateMergeRequest });
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
    node.innerHTML = `<div class="msg-meta">输出</div><div class="msg-bubble"></div>`;
    bubble = node.querySelector<HTMLElement>(".msg-bubble")!;
    meta = node.querySelector<HTMLElement>(".msg-meta")!;
  }

  meta!.textContent = "输出中…";
  bubble!.textContent += delta;
}

function describeToolProgress(event: JobEvent): string {
  const name = (event.toolName ?? "").toLowerCase();
  const detail = event.toolDetail ?? event.text ?? "";

  if (["grep", "glob", "ls"].includes(name)) return "正在定位相关代码...";
  if (["read", "notebookread"].includes(name)) return "正在阅读相关文件...";
  if (["edit", "multiedit", "write", "notebookedit"].includes(name)) return "正在修改文件...";
  if (name === "bash") {
    if (/test|lint|build|check|typecheck|tsc|npm|pnpm|yarn/i.test(detail)) {
      return "正在执行检查命令...";
    }
    if (/git/i.test(detail)) return "正在处理代码版本...";
    return "正在执行必要命令...";
  }
  if (name === "webfetch" || name === "websearch") return "正在查询相关资料...";
  if (event.toolAction === "done") return "已完成一个处理步骤";
  return "正在推进任务...";
}

function progressDetailText(event: JobEvent): string {
  const name = event.toolName ?? "工具";
  const action = event.toolAction === "done" ? "完成" : "开始";
  const detail = event.toolDetail || event.text || "";
  return detail ? `${action} ${name}: ${detail}` : `${action} ${name}`;
}

function upsertProgressCard(jobId: string, text: string, detail?: string): void {
  const node = ensureMessageElement(`${AGENT_PROGRESS_KEY}-${jobId}`, "msg msg-progress");
  if (!node.dataset.ready) {
    node.dataset.ready = "1";
    node.innerHTML = `
      <div class="progress-card">
        <div class="progress-main"></div>
        <details class="progress-details">
          <summary>
            <span class="progress-details-label">详细日志</span>
            <span class="progress-latest" hidden></span>
          </summary>
          <div class="progress-log"></div>
        </details>
      </div>
    `;
    const details = node.querySelector<HTMLDetailsElement>(".progress-details")!;
    const log = node.querySelector<HTMLElement>(".progress-log")!;
    details.addEventListener("toggle", () => {
      if (!details.open) return;
      requestAnimationFrame(() => {
        log.scrollTop = log.scrollHeight;
      });
    });
  }

  const main = node.querySelector<HTMLElement>(".progress-main")!;
  if (main.textContent !== text) {
    main.textContent = text;
  }

  if (detail) {
    const log = node.querySelector<HTMLElement>(".progress-log")!;
    const latest = node.querySelector<HTMLElement>(".progress-latest")!;
    const line = document.createElement("div");
    line.className = "progress-log-line";
    line.textContent = detail;
    log.appendChild(line);
    latest.textContent = detail;
    latest.hidden = false;
    if (node.querySelector<HTMLDetailsElement>(".progress-details")?.open) {
      requestAnimationFrame(() => {
        log.scrollTop = log.scrollHeight;
      });
    }
  }

  moveMessageToBottom(`${AGENT_PROGRESS_KEY}-${jobId}`);
}

function noteProgressActivity(text: string): void {
  lastProgressNoticeAt = Date.now();
  setConnectionStatus(text);
}

function upsertAgentStatus(event: JobEvent): void {
  const text = event.statusText ?? event.text;
  if (!text) return;

  upsertProgressCard(event.jobId, text);
  noteProgressActivity(text);
}

function appendToolLine(event: JobEvent): void {
  const text = describeToolProgress(event);
  upsertProgressCard(event.jobId, text, progressDetailText(event));
  noteProgressActivity(text);
}

function finalizeAgentStream(jobId = activeJobId): void {
  if (!jobId) return;
  const key = `${AGENT_STREAM_KEY}-${jobId}`;
  const node = el<HTMLElement>("chatMessages").querySelector<HTMLElement>(`[data-key="${key}"]`);
  const meta = node?.querySelector<HTMLElement>(".msg-meta");
  if (meta) meta.textContent = "输出";
}

function appendDoneBubble(event: JobEvent): void {
  finalizeAgentStream(event.jobId);
  const node = document.createElement("div");
  node.className = "msg msg-done";
  node.dataset.key = event.id;
  const text = escapeHtml(event.text ?? event.message ?? "任务完成");
  const branchInfo = event.branch
    ? `<div class="msg-sub">分支: ${escapeHtml(event.branch)}</div>`
    : "";
  const previewInfo = event.previewUrl
    ? `<div class="msg-sub">预览：<a href="${escapeHtml(event.previewUrl)}" target="_blank" rel="noreferrer">${escapeHtml(event.previewUrl)}</a></div>`
    : event.previewMessage
      ? `<div class="msg-sub">${escapeHtml(event.previewMessage)}</div>`
      : "";
  node.innerHTML = `
    <div class="msg-meta">${formatTime(event.timestamp)} · 完成</div>
    <div class="msg-bubble">${text}</div>
    ${branchInfo}
    ${previewInfo}
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
  finalizeAgentStream(event.jobId);
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

function syncComposerAutoHeight(): void {
  const footer = el<HTMLElement>("chatFooter");
  const hasManualAttachments = pendingAttachments.length > 0;
  const hasTapdImages =
    el<HTMLElement>("tapdContextStrip").querySelector(".tapd-context-image") !== null;
  const minimumHeight =
    140 +
    (hasManualAttachments ? 65 : 0) +
    (hasTapdImages ? 90 : 0);
  footer.dispatchEvent(
    new CustomEvent<number>("composer-auto-min-height", {
      detail: minimumHeight,
    })
  );
}

function renderAttachmentStrip(): void {
  const strip = el<HTMLElement>("attachmentStrip");
  if (pendingAttachments.length === 0) {
    strip.hidden = true;
    strip.innerHTML = "";
    syncComposerAutoHeight();
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
  syncComposerAutoHeight();
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

function tapdItemTypeLabel(itemType: TapdContext["itemType"]): string {
  if (itemType === "task") return "任务";
  if (itemType === "bug") return "Bug";
  return "需求";
}

function tapdContextKey(context: TapdContext): string {
  return `${context.workspaceId}:${context.itemType}:${context.itemId}:${context.fetchedAt}`;
}

function clearTapdImageCache(): void {
  for (const previewUrl of tapdImageCache?.previewUrls.values() ?? []) {
    URL.revokeObjectURL(previewUrl);
  }
  tapdImageCache = null;
}

async function prepareTapdContextImages(
  serverUrl: string,
  context: TapdContext,
  forceRetry = false
): Promise<PrepareTapdImagesResult> {
  const contextKey = tapdContextKey(context);
  if (
    tapdImageCache?.contextKey === contextKey &&
    (!forceRetry || !tapdImageCache.result.downloadFailed)
  ) {
    return tapdImageCache.result;
  }

  const result = await prepareTapdJobImages(
    serverUrl,
    context.sourceHtml,
    context.workspaceId
  );
  clearTapdImageCache();
  tapdImageCache = { contextKey, result, previewUrls: new Map() };
  return result;
}

function tapdImagePreviewUrl(sourceIndex: number, blob: Blob): string {
  const existing = tapdImageCache?.previewUrls.get(sourceIndex);
  if (existing) return existing;
  const previewUrl = URL.createObjectURL(blob);
  tapdImageCache?.previewUrls.set(sourceIndex, previewUrl);
  return previewUrl;
}

function renderTapdContext(): void {
  const strip = el<HTMLElement>("tapdContextStrip");
  const footer = el<HTMLElement>("chatFooter");
  strip.replaceChildren();
  if (!activeTapdContext) {
    strip.hidden = true;
    footer.classList.remove("has-tapd-context", "has-tapd-images");
    syncComposerAutoHeight();
    return;
  }

  const chip = document.createElement("div");
  chip.className = "tapd-context-chip";
  chip.title = activeTapdContext.url;

  const title = document.createElement("span");
  title.className = "tapd-context-chip-title";
  const excludedIndexes = new Set(activeTapdContext.excludedImageIndexes ?? []);
  const selectedImageCount = Math.max(
    0,
    (activeTapdContext.imageCount ?? 0) - excludedIndexes.size
  );
  const imageSummary = activeTapdContext.imageCount
    ? ` · ${selectedImageCount}/${activeTapdContext.imageCount} 张配图`
    : "";
  title.textContent = `TAPD ${tapdItemTypeLabel(activeTapdContext.itemType)} · ${activeTapdContext.title}${imageSummary}`;

  const remove = document.createElement("button");
  remove.className = "tapd-context-chip-remove";
  remove.type = "button";
  remove.title = "移除 TAPD 上下文";
  remove.setAttribute("aria-label", "移除 TAPD 上下文");
  remove.textContent = "×";
  remove.addEventListener("click", () => {
    void (async () => {
      activeTapdContext = null;
      clearTapdImageCache();
      await setCodingConversationTapdContext(activeConversationId);
      renderTapdContext();
      setConnectionStatus("已移除 TAPD 需求上下文");
    })();
  });

  chip.append(title, remove);
  strip.append(chip);

  const cached =
    tapdImageCache?.contextKey === tapdContextKey(activeTapdContext)
      ? tapdImageCache.result
      : null;
  const visibleImages =
    cached?.items.filter((item) => !excludedIndexes.has(item.sourceIndex)) ?? [];
  footer.classList.add("has-tapd-context");
  footer.classList.toggle("has-tapd-images", visibleImages.length > 0);
  if (visibleImages.length > 0) {
    const imageList = document.createElement("div");
    imageList.className = "tapd-context-images";
    for (const item of visibleImages) {
      const imageItem = document.createElement("div");
      imageItem.className = "tapd-context-image";

      const image = document.createElement("img");
      image.src = tapdImagePreviewUrl(item.sourceIndex, item.blob);
      image.alt = `TAPD 配图${item.sourceIndex}`;
      image.title = `TAPD 原描述配图${item.sourceIndex}`;

      const badge = document.createElement("span");
      badge.className = "tapd-context-image-label";
      badge.textContent = `配图${item.sourceIndex}`;

      const exclude = document.createElement("button");
      exclude.className = "tapd-context-image-remove";
      exclude.type = "button";
      exclude.title = `排除配图${item.sourceIndex}`;
      exclude.setAttribute("aria-label", `排除 TAPD 配图${item.sourceIndex}`);
      exclude.textContent = "×";
      exclude.addEventListener("click", () => {
        void (async () => {
          if (!activeTapdContext) return;
          const excluded = new Set(activeTapdContext.excludedImageIndexes ?? []);
          excluded.add(item.sourceIndex);
          activeTapdContext = {
            ...activeTapdContext,
            excludedImageIndexes: [...excluded].sort((left, right) => left - right),
          };
          await setCodingConversationTapdContext(activeConversationId, activeTapdContext);
          renderTapdContext();
          setConnectionStatus(`已排除 TAPD 配图${item.sourceIndex}`);
        })();
      });

      imageItem.append(image, badge, exclude);
      imageList.append(imageItem);
    }
    strip.append(imageList);
  }
  strip.hidden = false;
  syncComposerAutoHeight();
}

function buildLegacyTapdTransportContext(
  tapdContext: TapdContext | null,
  attachedImageIndexes: number[] = []
): PageContext | undefined {
  if (!tapdContext || tapdContext.transportMode === "structured") {
    return undefined;
  }

  const tapdReference = [
    "【当前对话关联的 TAPD 条目】",
    `类型：${tapdItemTypeLabel(tapdContext.itemType)}`,
    `标题：${tapdContext.title}`,
    `条目 ID：${tapdContext.itemId}`,
    tapdContext.status ? `状态：${tapdContext.status}` : "",
    tapdContext.owner ? `负责人：${tapdContext.owner}` : "",
    `地址：${tapdContext.url}`,
    "",
    "【需求描述】",
    tapdContext.description || "（TAPD 需求未填写描述）",
    tapdContext.imageCount
      ? `\n【TAPD 配图】\n描述中共有 ${tapdContext.imageCount} 张配图。本次附件映射：${
          attachedImageIndexes.length
            ? attachedImageIndexes
                .map((sourceIndex, attachmentIndex) => `附件图${attachmentIndex + 1}=原描述配图${sourceIndex}`)
                .join("；")
            : "没有附带 TAPD 配图"
        }。遇到“如图N”“图N”或“配图N”时只能按该映射读取，未附带的图片不可臆测。`
      : "",
  ]
    .filter((line) => line !== "")
    .join("\n");

  return {
    url: "",
    title: "TAPD 需求上下文",
    selectedText: tapdReference,
    viewport: { width: 0, height: 0 },
  };
}

function closeMentionMenu(): void {
  el<HTMLElement>("mentionMenu").hidden = true;
  mentionTriggerIndex = null;
}

function updateMentionMenu(): void {
  const prompt = el<HTMLTextAreaElement>("prompt");
  const caret = prompt.selectionStart ?? prompt.value.length;
  const triggerIndex = caret - 1;
  const isBoundary = triggerIndex === 0 || /\s/.test(prompt.value[triggerIndex - 1] ?? "");
  if (triggerIndex >= 0 && prompt.value[triggerIndex] === "@" && isBoundary) {
    mentionTriggerIndex = triggerIndex;
    el<HTMLElement>("mentionMenu").hidden = false;
    return;
  }
  closeMentionMenu();
}

function openTapdContextModal(): void {
  const modal = el<HTMLElement>("tapdContextModal");
  const input = el<HTMLInputElement>("tapdContextUrl");
  el<HTMLElement>("tapdContextHint").textContent = "";
  input.value = activeTapdContext?.url ?? "";
  modal.hidden = false;
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

function closeTapdContextModal(): void {
  if (tapdContextLoading) return;
  el<HTMLElement>("tapdContextModal").hidden = true;
}

function selectTapdMention(): void {
  const prompt = el<HTMLTextAreaElement>("prompt");
  if (mentionTriggerIndex !== null) {
    const start = mentionTriggerIndex;
    const caret = prompt.selectionStart ?? start + 1;
    prompt.value = `${prompt.value.slice(0, start)}${prompt.value.slice(caret)}`;
    prompt.setSelectionRange(start, start);
  }
  closeMentionMenu();
  updateSubmitButton();
  openTapdContextModal();
}

async function attachTapdContextFromModal(): Promise<void> {
  if (tapdContextLoading) return;
  const url = el<HTMLInputElement>("tapdContextUrl").value.trim();
  const hint = el<HTMLElement>("tapdContextHint");
  const okButton = el<HTMLButtonElement>("tapdContextOk");
  if (!url) {
    hint.textContent = "请输入 TAPD 链接";
    return;
  }

  const config = await loadConfig();
  if (!config.serverUrl) {
    hint.textContent = "请先在设置中配置服务端地址";
    return;
  }

  const targetConversationId = activeConversationId;
  tapdContextLoading = true;
  okButton.disabled = true;
  okButton.textContent = "正在获取…";
  hint.textContent = "正在远程获取 TAPD 条目描述…";
  try {
    const context = await resolveTapdContext(config.serverUrl, url);
    let imageResult: PrepareTapdImagesResult | null = null;
    if ((context.imageCount ?? 0) > 0 && context.sourceHtml) {
      hint.textContent = `正在读取 TAPD 描述中的 ${context.imageCount} 张配图…`;
      imageResult = await prepareTapdContextImages(config.serverUrl, context);
    }
    await setCodingConversationTapdContext(targetConversationId, context);
    if (activeConversationId === targetConversationId) {
      activeTapdContext = context;
      renderTapdContext();
    }
    el<HTMLElement>("tapdContextModal").hidden = true;
    if (imageResult) {
      const loaded = imageResult.images.length;
      const expected = imageResult.expectedInHtml;
      setConnectionStatus(
        loaded > 0
          ? `已关联 TAPD：${context.title}，已读取 ${loaded}/${expected} 张配图`
          : `已关联 TAPD：${context.title}；配图暂未读取，发送时将重试`
      );
    } else {
      setConnectionStatus(`已关联 TAPD：${context.title}`);
    }
    el<HTMLTextAreaElement>("prompt").focus();
  } catch (err) {
    hint.textContent = err instanceof Error ? err.message : "获取 TAPD 条目失败";
  } finally {
    tapdContextLoading = false;
    okButton.disabled = false;
    okButton.textContent = "关联";
  }
}

function setupTapdContextMention(): void {
  const prompt = el<HTMLTextAreaElement>("prompt");
  const menu = el<HTMLElement>("mentionMenu");

  prompt.addEventListener("input", updateMentionMenu);
  prompt.addEventListener("click", () => {
    if (!menu.hidden) updateMentionMenu();
  });
  prompt.addEventListener("keydown", (event) => {
    if (menu.hidden) return;
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      event.stopImmediatePropagation();
      selectTapdMention();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeMentionMenu();
    }
  });

  el<HTMLButtonElement>("mentionTapdOption").addEventListener("click", selectTapdMention);
  document.addEventListener("pointerdown", (event) => {
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (!menu.hidden && !menu.contains(target) && target !== prompt) {
      closeMentionMenu();
    }
  });

  el<HTMLButtonElement>("tapdContextOk").addEventListener("click", () => {
    void attachTapdContextFromModal();
  });
  el<HTMLButtonElement>("tapdContextCancel").addEventListener("click", closeTapdContextModal);
  el<HTMLElement>("tapdContextBackdrop").addEventListener("click", closeTapdContextModal);
  el<HTMLInputElement>("tapdContextUrl").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      void attachTapdContextFromModal();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !el<HTMLElement>("tapdContextModal").hidden) {
      closeTapdContextModal();
    }
  });
}

function handleJobEvent(
  event: JobEvent,
  options?: { skipPersist?: boolean; allowOtherJobs?: boolean; replay?: boolean }
): void {
  if (!options?.allowOtherJobs && activeJobId && event.jobId !== activeJobId) return;
  if (seenEventIds.has(event.id)) return;
  seenEventIds.add(event.id);
  lastEventAt = Date.now();
  if (event.previewUrl) previewUrls.set(event.jobId, event.previewUrl);
  if (event.previewMessage) previewMessages.set(event.jobId, event.previewMessage);
  if (event.mergeRetryable !== undefined) {
    mergeRetryableJobs.set(event.jobId, event.mergeRetryable);
  }

  if (options?.replay) {
    switch (event.type) {
      case "user":
        appendUserBubble(event);
        break;
      case "queue":
        updateQueueCard(event);
        break;
      case "stage":
        appendStageBubble(event);
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
        appendDoneBubble(event);
        break;
      case "cancelled":
        appendCancelledBubble(event);
        break;
      case "error":
        appendErrorBubble(event);
        break;
    }
    scrollChatToBottom();
    return;
  }

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
          startActionAlert("Plan 已生成，等待执行修改");
          stopProgressIdleNotice();
          updateSubmitButton();
        });
      } else if (event.phase === "plan_need_more") {
        flushPlanResultBubble(event.jobId);
        currentJobStatus = "awaiting_input";
        upsertConfirmCard(event.jobId, "awaiting_input");
        setConnectionStatus("需要补充信息");
        startActionAlert("Plan 需要补充信息");
        stopProgressIdleNotice();
        updateSubmitButton();
      } else if (event.phase === "execute_confirmed") {
        lockPlanResultBubble(event.jobId);
        currentJobStatus = "pending";
        upsertConfirmCard(event.jobId, "pending");
        setConnectionStatus("正在准备独立工作区");
        stopActionAlert();
        updateSubmitButton();
      } else if (event.phase === "execute_ready" || event.phase === "merge_retryable") {
        currentJobStatus = "awaiting_merge";
        removeMessageByKey(`${CONFIRM_CARD_KEY}-${event.jobId}`);
        upsertMergeConfirmCard(
          event.jobId,
          "awaiting_merge",
          event.previewUrl,
          event.previewMessage,
          event.mergeRetryable
        );
        setConnectionStatus(event.mergeRetryable ? "等待重试合并" : "等待确认合并");
        startActionAlert(event.mergeRetryable
          ? "Git 仓库不可用，等待重试合并"
          : createMergeRequestOnMerge
            ? "修改完成，等待提交 Merge Request"
            : "修改完成，等待合并确认");
        stopProgressIdleNotice();
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
        stopActionAlert();
        updateSubmitButton();
      } else if (event.phase === "merge_request") {
        currentJobStatus = "running";
        upsertMergeConfirmCard(event.jobId, "running");
        setConnectionStatus("正在提交 Merge Request");
        stopActionAlert();
        updateSubmitButton();
      } else if (event.phase === "release_merge_done" || event.phase === "default_revert_done") {
        refreshTaskDrawer();
      } else if (event.phase && ["pull", "branch", "agent", "commit"].includes(event.phase)) {
        currentJobStatus = "running";
        setConnectionStatus("执行中");
        stopActionAlert();
        updateSubmitButton();
      } else if (event.phase === "plan") {
        resetPlanOutputBuffer(event.jobId);
        currentJobStatus = "planning";
        removeMessageByKey(`${CONFIRM_CARD_KEY}-${event.jobId}`);
        setConnectionStatus("Plan 分析中");
        stopActionAlert();
        updateSubmitButton();
      } else if (event.phase === "question") {
        currentJobStatus = "running";
        setConnectionStatus("项目分析中（只读）");
        stopActionAlert();
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
      if (!hasExistingGateCard(event.jobId)) appendDoneBubble(event);
      updateExistingGateCards(event.jobId, "completed");
      setConnectionStatus("任务已完成");
      stopActionAlert();
      stopProgressIdleNotice();
      activeStream?.close();
      activeStream = null;
      updateSubmitButton();
      refreshTaskDrawer();
      break;
    case "cancelled":
      resetPlanOutputBuffer(null);
      currentJobStatus = "cancelled";
      if (!hasExistingGateCard(event.jobId)) appendCancelledBubble(event);
      updateExistingGateCards(event.jobId, "cancelled");
      setConnectionStatus("任务已取消");
      stopActionAlert();
      stopProgressIdleNotice();
      activeStream?.close();
      activeStream = null;
      updateSubmitButton();
      refreshTaskDrawer();
      break;
    case "error":
      resetPlanOutputBuffer(null);
      if (isCancelledEvent(event)) {
        currentJobStatus = "cancelled";
        if (!hasExistingGateCard(event.jobId)) appendCancelledBubble(event);
        updateExistingGateCards(event.jobId, "cancelled");
        setConnectionStatus("任务已取消");
        stopActionAlert();
        stopProgressIdleNotice();
      } else {
        currentJobStatus = "failed";
        if (!hasExistingGateCard(event.jobId)) appendErrorBubble(event);
        updateExistingGateCards(event.jobId, "failed");
        setConnectionStatus("任务失败");
        stopActionAlert();
        stopProgressIdleNotice();
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

  if (
    event.type === "done" ||
    (event.type === "stage" &&
      ["plan_done", "plan_need_more", "execute_ready", "merge_retryable"].includes(event.phase ?? ""))
  ) {
    void refreshSubmitButtonContextTitle();
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
  startProgressIdleNotice(jobId);

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

function buildTapdBugTitle(planSummary: string): string {
  const maxTitleLength = 29;
  const plain = planSummary
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`[\]-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const firstSentence = plain.split(/[。！？.!?]/)[0]?.trim() || plain || "AI 修改问题反馈";
  return firstSentence.length > maxTitleLength ? firstSentence.slice(0, maxTitleLength) : firstSentence;
}

interface TapdBugSelection {
  workspaceId: string;
  iterationId: string;
}

let tapdBugResolver: ((selection: TapdBugSelection | null) => void) | null = null;
let tapdBugLoadIterations: ((workspaceId: string) => Promise<void>) | null = null;

function closeTapdBugModal(selection: TapdBugSelection | null): void {
  const modal = document.getElementById("tapdBugModal");
  if (modal) modal.hidden = true;
  const resolver = tapdBugResolver;
  tapdBugResolver = null;
  tapdBugLoadIterations = null;
  resolver?.(selection);
}

function workspaceLabel(workspace: TapdWorkspace): string {
  return workspace.pretty_name ?? workspace.name ?? `项目 ${workspace.id}`;
}

function renderTapdBugIterations(iterations: TapdIteration[]): void {
  const selectEl = el<HTMLSelectElement>("tapdBugIteration");
  const okBtn = el<HTMLButtonElement>("tapdBugOk");
  selectEl.innerHTML = iterations.length
    ? iterations
        .map((iteration) => {
          const label = [iteration.name, iteration.status, iteration.enddate].filter(Boolean).join(" · ");
          return `<option value="${escapeHtml(iteration.id)}">${escapeHtml(label)}</option>`;
        })
        .join("")
    : `<option value="">暂无可选迭代</option>`;
  selectEl.disabled = iterations.length === 0;
  okBtn.disabled = iterations.length === 0;
}

function showTapdBugModal(input: {
  job: JobStatus;
  serverUrl: string;
  title: string;
  defaultWorkspaceId: string;
  workspaces: TapdWorkspace[];
}): Promise<TapdBugSelection | null> {
  return new Promise((resolve) => {
    const modal = el<HTMLElement>("tapdBugModal");
    const titleEl = el<HTMLElement>("tapdBugTitle");
    const planEl = el<HTMLElement>("tapdBugPlan");
    const workspaceEl = el<HTMLSelectElement>("tapdBugWorkspace");
    const hintEl = el<HTMLElement>("tapdBugHint");
    const okBtn = el<HTMLButtonElement>("tapdBugOk");

    tapdBugResolver = resolve;
    titleEl.textContent = input.title;
    planEl.textContent = input.job.planSummary ?? "";
    workspaceEl.innerHTML = input.workspaces.length
      ? input.workspaces
          .map((workspace) => {
            return `<option value="${escapeHtml(workspace.id)}">${escapeHtml(workspaceLabel(workspace))}</option>`;
          })
          .join("")
      : `<option value="">暂无可选项目</option>`;
    workspaceEl.disabled = input.workspaces.length === 0;
    okBtn.disabled = true;
    renderTapdBugIterations([]);
    hintEl.textContent = input.workspaces.length === 0
      ? "未加载到 TAPD 项目，请检查 TAPD 配置。"
      : "请选择项目，迭代将按项目联动加载。";

    const defaultWorkspace = input.workspaces.find((workspace) => workspace.id === input.defaultWorkspaceId);
    workspaceEl.value = defaultWorkspace?.id ?? input.workspaces[0]?.id ?? "";
    refreshCustomSelect(workspaceEl);
    tapdBugLoadIterations = async (workspaceId: string) => {
      if (!workspaceId) {
        renderTapdBugIterations([]);
        hintEl.textContent = "请先选择 TAPD 项目。";
        return;
      }
      renderTapdBugIterations([]);
      hintEl.textContent = "正在加载该项目的迭代...";
      try {
        const result = await fetchTapdIterations(input.serverUrl, workspaceId);
        if (workspaceEl.value !== workspaceId) return;
        renderTapdBugIterations(result.iterations);
        hintEl.textContent = result.iterations.length === 0
          ? "当前项目暂无可选迭代。"
          : "缺陷内容将使用当前任务的 Plan 方案原文。";
      } catch (err) {
        if (workspaceEl.value !== workspaceId) return;
        renderTapdBugIterations([]);
        hintEl.textContent = err instanceof Error ? err.message : String(err);
      }
    };

    modal.hidden = false;
    if (workspaceEl.value) {
      workspaceEl.focus();
      void tapdBugLoadIterations(workspaceEl.value);
    } else {
      el<HTMLButtonElement>("tapdBugCancel").focus();
    }
  });
}

function setupTapdBugModal(): void {
  el<HTMLButtonElement>("tapdBugOk").addEventListener("click", () => {
    const workspaceId = el<HTMLSelectElement>("tapdBugWorkspace").value;
    const iterationId = el<HTMLSelectElement>("tapdBugIteration").value;
    closeTapdBugModal(workspaceId && iterationId ? { workspaceId, iterationId } : null);
  });
  el<HTMLSelectElement>("tapdBugWorkspace").addEventListener("change", () => {
    const workspaceId = el<HTMLSelectElement>("tapdBugWorkspace").value;
    void tapdBugLoadIterations?.(workspaceId);
  });
  el<HTMLButtonElement>("tapdBugCancel").addEventListener("click", () => {
    closeTapdBugModal(null);
  });
  el<HTMLElement>("tapdBugBackdrop").addEventListener("click", () => {
    closeTapdBugModal(null);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const modal = document.getElementById("tapdBugModal");
    if (modal && !modal.hidden) {
      closeTapdBugModal(null);
    }
  });
}

async function handleCreateTapdBug(job: JobStatus): Promise<void> {
  const config = await loadConfig();
  if (!config.serverUrl) {
    setConnectionStatus("请先在设置中配置服务端地址");
    return;
  }
  const planSummary = job.planSummary?.trim();
  if (!planSummary) {
    setConnectionStatus("当前任务没有 Plan 方案，无法提交 bug");
    return;
  }

  try {
    setConnectionStatus("正在加载 TAPD 项目...");
    const result = await fetchTapdWorkspaces(config.serverUrl);
    if (result.warning) {
      setConnectionStatus(`TAPD 项目列表接口受限，已使用本地配置项目：${result.warning}`);
    }
    const title = buildTapdBugTitle(planSummary);
    const selection = await showTapdBugModal({
      job,
      serverUrl: config.serverUrl,
      title,
      defaultWorkspaceId: result.defaultWorkspaceId,
      workspaces: result.workspaces,
    });
    if (!selection) {
      setConnectionStatus("已取消提交 TAPD bug");
      return;
    }

    setConnectionStatus("正在提交 TAPD bug...");
    const created = await createTapdBug(config.serverUrl, {
      title,
      description: planSummary,
      iterationId: selection.iterationId,
      workspaceId: selection.workspaceId,
    });
    setConnectionStatus(`已提交 TAPD bug：${created.bug.name ?? created.bug.id}`);
  } catch (err) {
    setConnectionStatus(formatErrorMessage(config.serverUrl, err));
  }
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
  const usePlanMode = el<HTMLInputElement>("usePlanMode")?.checked ?? false;
  const submitBtn = el<HTMLButtonElement>("submitBtn");
  const config = await loadConfig();

  if (!prompt) {
    setConnectionStatus("请输入");
    return;
  }
  if (!config.serverUrl) {
    setConnectionStatus("请先在设置中配置服务端地址");
    return;
  }

  await flushPendingServerCancel(config.serverUrl);

  if (!activeConversationId) {
    activeConversationId = (await getActiveCodingConversation()).id;
  }

  submitInFlight = true;
  updateSubmitButton();
  seenEventIds.clear();
  resetPlanOutputBuffer(null);

  try {
    currentJobStatus = null;
    updateSubmitButton();

    const submissionTapdContext = activeTapdContext;
    let tapdImageResult: PrepareTapdImagesResult | null = null;
    if ((submissionTapdContext?.imageCount ?? 0) > 0 && submissionTapdContext?.sourceHtml) {
      setConnectionStatus("正在准备 TAPD 描述配图…");
      tapdImageResult = await prepareTapdContextImages(
        config.serverUrl,
        submissionTapdContext,
        true
      );
    }
    const excludedImageIndexes = new Set(
      submissionTapdContext?.excludedImageIndexes ?? []
    );
    const selectedTapdImages =
      tapdImageResult?.items.filter(
        (item) => !excludedImageIndexes.has(item.sourceIndex)
      ) ?? [];
    if (selectedTapdImages.length + pendingAttachments.length > MAX_ATTACHMENTS) {
      setConnectionStatus(
        `当前选中的 TAPD 配图与手动截图合计不能超过 ${MAX_ATTACHMENTS} 张，请继续排除图片`
      );
      return;
    }

    const { blobs: manualImageBlobs, previewUrls: manualPreviewUrls } =
      detachPendingAttachments();
    const tapdImageBlobs = selectedTapdImages.map((item) => item.blob);
    const tapdImageIndexes = selectedTapdImages.map((item) => item.sourceIndex);
    const tapdPreviewUrls = selectedTapdImages.map((item) =>
      URL.createObjectURL(item.blob)
    );
    const imageBlobs = [...tapdImageBlobs, ...manualImageBlobs];
    const previewUrls = [...tapdPreviewUrls, ...manualPreviewUrls];
    const imageNames = [
      ...selectedTapdImages.map(
        (item) => `tapd-description-${item.sourceIndex}.webp`
      ),
      ...manualImageBlobs.map((_blob, index) => `screenshot-${index + 1}.webp`),
    ];
    const usesStructuredTapdContext = submissionTapdContext?.transportMode === "structured";
    const transportTapdContext = submissionTapdContext
      ? {
          ...submissionTapdContext,
          attachedImageCount: tapdImageBlobs.length,
          attachedImageIndexes: tapdImageIndexes,
        }
      : null;
    const body: SubmitRequest = {
      prompt,
      pageContext: usesStructuredTapdContext
        ? undefined
        : buildLegacyTapdTransportContext(transportTapdContext, tapdImageIndexes),
      tapdContext: usesStructuredTapdContext ? transportTapdContext ?? undefined : undefined,
      conversationId: activeConversationId,
      images: imageBlobs.length > 0 ? imageBlobs : undefined,
      imageNames: imageNames.length > 0 ? imageNames : undefined,
    };
    const effectivePlan = usePlanMode;

    // 立即显示用户消息，避免等待接口期间“没反应”
    const localId = `local-${Date.now()}`;
    appendUserBubble(
      {
        id: localId,
        jobId: "pending",
        timestamp: new Date().toISOString(),
        type: "user",
        text: prompt,
        attachmentCount: previewUrls.length > 0 ? previewUrls.length : undefined,
      },
      previewUrls
    );
    lastLocalUserBubble = {
      localId,
      text: prompt,
      createdAtMs: Date.now(),
      imageUrls: previewUrls,
    };
    scrollChatToBottom();

    let data: Awaited<ReturnType<typeof submitQuestion>>;
    try {
      data = effectivePlan
        ? await submitPlan(config.serverUrl, body)
        : await submitQuestion(config.serverUrl, body);
    } catch (submitErr) {
      for (const [index, blob] of manualImageBlobs.entries()) {
        pendingAttachments.push({
          id: `att-restore-${Date.now()}-${index}`,
          blob,
          previewUrl: manualPreviewUrls[index],
          label: formatBytes(blob.size),
        });
      }
      renderAttachmentStrip();
      throw submitErr;
    }

    el<HTMLTextAreaElement>("prompt").value = "";
    await addJobToCodingConversation(activeConversationId, data.jobId, prompt);
    if (effectivePlan) {
      const savedTask = await saveCodingPromptAsTask({
        prompt,
        conversationId: activeConversationId,
      });
      await attachJobToCodingTask(savedTask.id, data.jobId);
    }
    refreshTaskDrawer();
    await initCodingJobSession(data.jobId, data.status as JobStatusType);
    await chrome.storage.local.set({ lastJobId: data.jobId });
    resetPlanOutputBuffer(data.jobId);

    connectJobStream(config.serverUrl, data.jobId, data.status as JobStatusType);
    const imageWarning =
      tapdImageResult &&
      tapdImageResult.expectedInHtml > tapdImageResult.items.length
        ? `（TAPD 配图仅读取 ${tapdImageResult.items.length}/${tapdImageResult.expectedInHtml} 张）`
        : "";
    setConnectionStatus(
      `${effectivePlan ? "Plan 分析中…" : data.message || "正在只读分析项目"}${imageWarning}`
    );
  } catch (err) {
    setConnectionStatus(formatErrorMessage(config.serverUrl, err));
  } finally {
    submitInFlight = false;
    updateSubmitButton();
  }
}

function closeSettingsModal(): void {
  const modal = el<HTMLElement>("settingsModal");
  modal.hidden = true;
}

async function openSettingsModal(): Promise<void> {
  const modal = el<HTMLElement>("settingsModal");
  const result = el<HTMLElement>("settingsSaveResult");
  const resultText = el<HTMLElement>("settingsSaveResultText");
  const config = await loadConfig();

  el<HTMLInputElement>("settingsServerUrl").value = config.serverUrl;
  el<HTMLInputElement>("settingsCreateMergeRequestOnMerge").checked =
    config.createMergeRequestOnMerge;
  result.classList.add("hidden");
  resultText.textContent = "";
  modal.hidden = false;
  el<HTMLInputElement>("settingsServerUrl").focus();
}

async function saveSettingsFromModal(): Promise<void> {
  const serverUrl = el<HTMLInputElement>("settingsServerUrl").value.trim();
  const createMergeRequest = el<HTMLInputElement>("settingsCreateMergeRequestOnMerge").checked;
  const result = el<HTMLElement>("settingsSaveResult");
  const resultText = el<HTMLElement>("settingsSaveResultText");

  result.classList.remove("hidden");

  if (!serverUrl) {
    resultText.textContent = "请填写服务端地址";
    resultText.style.color = "#fca5a5";
    return;
  }

  await saveConfig({
    serverUrl,
    createMergeRequestOnMerge: createMergeRequest,
  });
  createMergeRequestOnMerge = createMergeRequest;
  resultText.textContent = "已保存";
  resultText.style.color = "#86efac";
  setConnectionStatus("设置已保存");
}

function setupSettingsModal(): void {
  el<HTMLElement>("settingsBtn").addEventListener("click", () => {
    void openSettingsModal();
  });
  el<HTMLElement>("settingsBackdrop").addEventListener("click", closeSettingsModal);
  el<HTMLButtonElement>("settingsClose").addEventListener("click", closeSettingsModal);
  el<HTMLButtonElement>("settingsCancel").addEventListener("click", closeSettingsModal);
  el<HTMLButtonElement>("settingsSave").addEventListener("click", () => {
    void saveSettingsFromModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !el<HTMLElement>("settingsModal").hidden) {
      closeSettingsModal();
    }
  });
}

async function init(): Promise<void> {
  const config = await loadConfig();
  createMergeRequestOnMerge = config.createMergeRequestOnMerge;
  enhanceSelects(document.querySelectorAll<HTMLSelectElement>("select"));
  await migrateLegacyTaskConversations();
  activeConversationId = (await getActiveCodingConversation()).id;

  setupSettingsModal();
  initCodingTaskPicker({
    onSelectConversation: openCodingConversation,
    onConversationDeleted: openCodingConversation,
    onReleaseMerge: handleReleaseMerge,
    onRevertDefault: handleRevertDefault,
    onCreateTapdBug: handleCreateTapdBug,
    onStatus: setConnectionStatus,
  });
  el<HTMLButtonElement>("newConversationBtn").addEventListener("click", () => {
    void createAndOpenConversation();
  });
  el<HTMLFormElement>("composer").addEventListener("submit", (event) => {
    event.preventDefault();
    void handleSubmit();
  });
  setupAttachmentHandlers();
  setupTapdContextMention();
  setupComposerResize({
    storageKey: "tapdComposerFooterHeight",
    scrollContainerId: "chatMain",
  });
  setupSidebarResize();
  setupReleaseMergeModal();
  setupRevertDefaultModal();
  setupTapdBugModal();

  el<HTMLTextAreaElement>("prompt").addEventListener("keydown", (e) => {
    if (e.defaultPrevented) return;
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      el<HTMLFormElement>("composer").requestSubmit();
    }
  });
  el<HTMLTextAreaElement>("prompt").addEventListener("input", updateSubmitButton);

  window.addEventListener("focus", () => {
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

  await openCodingConversation(activeConversationId);
}

init();
