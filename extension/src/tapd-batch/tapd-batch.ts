import "../shared/styles.css";
import "./tapd-batch.css";
import { loadConfig } from "../shared/config.js";
import { formatErrorMessage, fetchJobEvents, queryJobStatus } from "../shared/api.js";
import { JobProgressView } from "../shared/jobProgressView.js";
import {
  buildTaskPrompt,
  fetchTapdIterationTasks,
  fetchTapdIterations,
  TAPD_TASK_PREFIX,
} from "../shared/tapdApi.js";
import { sendTapdBatchCommand } from "../shared/tapdBatchClient.js";
import { TAPD_BATCH_JOB_EVENT, TAPD_BATCH_JOB_LOG, TAPD_BATCH_STATE } from "../shared/tapdBatchMessages.js";
import {
  createBatchTask,
  listCompletedTapdTaskIds,
  loadTapdBatchSession,
  saveTapdBatchSession,
} from "../shared/tapdBatchStore.js";
import type { JobEvent, TapdBatchSession, TapdBatchTask, TapdIteration, TapdTaskItem } from "../shared/types.js";

interface PickerRow {
  task: TapdTaskItem;
  prompt: string;
  sourceHtml: string;
  checked: boolean;
  previouslyCompleted: boolean;
}

let serverUrl = "";
let workspaceId = "";
let iterations: TapdIteration[] = [];
let pickerRows: PickerRow[] = [];
let session: TapdBatchSession | null = null;
let loopRunning = false;
let progressView: JobProgressView | null = null;
let activeProgressJobId: string | null = null;

const SELECTED_ITERATION_KEY = "tapdBatchSelectedIterationId";

let panelRoot: HTMLElement | null = null;
let panelInitialized = false;
let tapdResetConfirmResolver: ((confirmed: boolean) => void) | null = null;

export interface TapdBatchPanelOptions {
  onBack?: () => void;
}

function el<T extends HTMLElement>(id: string): T {
  if (!panelRoot) throw new Error("TAPD batch panel not mounted");
  const node = panelRoot.querySelector<T>(`#${id}`);
  if (!node) throw new Error(`Missing #${id} in TAPD batch panel`);
  return node;
}

function setStatus(text: string): void {
  el<HTMLElement>("batchStatus").textContent = text;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function statusLabel(status: TapdBatchTask["status"]): string {
  const map: Record<TapdBatchTask["status"], string> = {
    pending: "待执行",
    running: "执行中",
    completed: "已完成",
    failed: "失败",
    skipped: "已跳过",
  };
  return map[status] ?? status;
}

function sessionStatusLabel(status: TapdBatchSession["status"]): string {
  const map: Record<TapdBatchSession["status"], string> = {
    idle: "就绪",
    running: "任务运行中",
    waiting_confirm: "等待确认 Plan",
    waiting_merge: "等待确认合并",
    waiting_input: "需要补充信息",
    paused: "已暂停",
    completed: "全部任务已完成",
    cancelled: "已终止",
  };
  return map[status] ?? status;
}

function isBatchBusy(): boolean {
  return (
    loopRunning ||
    session?.status === "running" ||
    session?.status === "waiting_confirm" ||
    session?.status === "waiting_merge" ||
    session?.status === "waiting_input"
  );
}

function hasActiveBatchSession(next: TapdBatchSession | null): boolean {
  return Boolean(
    next &&
      next.tasks.length > 0 &&
      next.status !== "idle" &&
      next.status !== "completed" &&
      next.status !== "cancelled"
  );
}

function ensureProgressView(): JobProgressView {
  if (!progressView) {
    progressView = new JobProgressView(el<HTMLElement>("jobProgressLog"), {
      onStatus: setStatus,
      onConfirmExecute: (jobId, planSummary) => {
        void sendTapdBatchCommand({ type: "TAPD_BATCH_CONFIRM_EXECUTE", planSummary }).then(() => {
          progressView?.renderConfirmCard(jobId, "pending");
        });
      },
      onPlanReply: (jobId, reply) => {
        if (session?.activeJobId && session.activeJobId !== jobId) {
          setStatus("任务已更新，请点「重试当前」后重新操作");
          return;
        }
        void sendTapdBatchCommand<{ ok: boolean; error?: string }>({
          type: "TAPD_BATCH_PLAN_REPLY",
          reply,
        }).then((result) => {
          if (result?.ok === false) {
            setStatus(result.error ?? "继续分析失败");
            void syncStateFromBackground();
            return;
          }
          progressView?.renderConfirmCard(jobId, "planning");
          setStatus("正在根据补充说明继续分析...");
        });
      },
      onCancelJob: () => {
        void sendTapdBatchCommand({ type: "TAPD_BATCH_PAUSE" });
      },
      onConfirmMerge: (jobId) => {
        void sendTapdBatchCommand({ type: "TAPD_BATCH_CONFIRM_MERGE" }).then(() => {
          progressView?.renderMergeCard(jobId, "running");
        });
      },
      onDiscardMerge: (jobId) => {
        void sendTapdBatchCommand<{ ok: boolean; error?: string }>({
          type: "TAPD_BATCH_DISCARD_MERGE",
        }).then((result) => {
          if (result?.ok === false) {
            setStatus(result.error ?? "放弃合并失败");
            return;
          }
          progressView?.renderMergeCard(jobId, "cancelled");
          setStatus("已放弃合并");
          void syncStateFromBackground();
        });
      },
    });
  }
  return progressView;
}

function scrollProgressToBottom(): void {
  const log = el<HTMLElement>("jobProgressLog");
  log.scrollTop = log.scrollHeight;
}

function ensureGateCards(jobId: string, status?: TapdBatchSession["status"], planSummary?: string): void {
  if (!status) return;
  const view = ensureProgressView();
  el<HTMLElement>("progressSection").hidden = false;

  if (status === "waiting_confirm") {
    if (planSummary) view.renderPlan(jobId, planSummary, true);
    view.renderConfirmCard(jobId, "awaiting_confirm");
  } else if (status === "waiting_input") {
    if (planSummary) view.renderPlan(jobId, planSummary, false);
    view.renderConfirmCard(jobId, "awaiting_input");
  } else if (status === "waiting_merge") {
    view.renderMergeCard(jobId, "awaiting_merge");
  }
  scrollProgressToBottom();
}

async function loadJobLogForReplay(jobId: string): Promise<JobEvent[]> {
  const stored = await chrome.storage.local.get([TAPD_BATCH_JOB_LOG]);
  const current = stored[TAPD_BATCH_JOB_LOG] as { jobId: string; events: JobEvent[] } | undefined;
  if (current?.jobId === jobId && current.events.length > 0) return current.events;
  if (!serverUrl) return [];
  try {
    return await fetchJobEvents(serverUrl, jobId);
  } catch {
    return [];
  }
}

async function replayJobProgress(jobId: string, planSummary?: string, status?: TapdBatchSession["status"]): Promise<void> {
  const view = ensureProgressView();
  el<HTMLElement>("progressSection").hidden = false;
  if (activeProgressJobId !== jobId) {
    view.reset();
    activeProgressJobId = jobId;
    const events = await loadJobLogForReplay(jobId);
    for (const event of events) view.handleEvent(event);
  }
  const progressStatus =
    status === "waiting_confirm"
      ? "waiting_confirm"
      : status === "waiting_input"
        ? "waiting_input"
        : status === "waiting_merge"
          ? "waiting_merge"
          : undefined;
  if (planSummary || progressStatus) {
    view.syncSessionState({
      jobId,
      planSummary,
      status: progressStatus ?? "running",
    });
  } else if (
    status === "waiting_confirm" ||
    status === "waiting_input" ||
    status === "waiting_merge"
  ) {
    ensureGateCards(jobId, status, planSummary);
  }
  scrollProgressToBottom();
}

function applySession(next: TapdBatchSession | null): void {
  session = next;
  renderQueue();
  updateFooter();

  if (!hasActiveBatchSession(next)) {
    if (!next) {
      el<HTMLElement>("progressSection").hidden = true;
      setStatus("就绪");
    } else if (next.status === "cancelled" || next.status === "completed") {
      setStatus(next.pauseReason ?? sessionStatusLabel(next.status));
      ensureProgressView().clearGateCards();
    }
    return;
  }

  setStatus(next!.pauseReason ?? sessionStatusLabel(next!.status));
  el<HTMLElement>("queueSection").hidden = false;

  if (next!.status === "paused" || next!.status === "cancelled") {
    ensureProgressView().clearGateCards();
    return;
  }

  if (next!.activeJobId) {
    void replayJobProgress(next!.activeJobId, next!.planSummary, next!.status).then(() => {
      ensureGateCards(next!.activeJobId!, next!.status, next!.planSummary);
    });
  } else if (next!.status === "completed") {
    // keep last progress visible
  }
}

function pickDefaultIterationId(list: TapdIteration[]): string {
  const open = list.find((item) => item.status === "open");
  return open?.id ?? list[0]?.id ?? "";
}

function renderIterationOptions(selectedId: string): void {
  const select = el<HTMLSelectElement>("iterationSelect");
  if (iterations.length === 0) {
    select.innerHTML = `<option value="">暂无迭代</option>`;
    return;
  }

  select.innerHTML = iterations
    .map((iteration) => {
      const label = [iteration.name, iteration.status, iteration.enddate]
        .filter(Boolean)
        .join(" · ");
      return `<option value="${escapeHtml(iteration.id)}"${iteration.id === selectedId ? " selected" : ""}>${escapeHtml(label)}</option>`;
    })
    .join("");
}

function renderTaskPicker(): void {
  const container = el<HTMLElement>("taskPickerList");
  const busy = isBatchBusy();
  if (pickerRows.length === 0) {
    container.innerHTML = `<p class="batch-empty">当前迭代没有以 ${TAPD_TASK_PREFIX} 开头的任务</p>`;
    return;
  }

  container.innerHTML = pickerRows
    .map((row, index) => {
      const badge = [
        row.previouslyCompleted ? `<span class="batch-badge done">曾执行</span>` : "",
        (row.task.imageCount ?? 0) > 0
          ? `<span class="batch-badge">${row.task.imageCount} 张配图</span>`
          : "",
      ].join("");
      const owner = row.task.owner ? ` · ${escapeHtml(row.task.owner)}` : "";
      const status = row.task.status ? ` · ${escapeHtml(row.task.status)}` : "";
      return `
        <div class="batch-task-item${row.previouslyCompleted ? " is-done" : ""}">
          <div class="batch-task-head">
            <input type="checkbox" data-picker-index="${index}" ${row.checked ? "checked" : ""} ${busy ? "disabled" : ""} />
            <div class="batch-task-meta">
              <div class="batch-task-title">${escapeHtml(row.task.name)}${badge}</div>
              <div class="batch-task-sub">#${escapeHtml(row.task.id)}${owner}${status}</div>
            </div>
          </div>
          <textarea class="batch-prompt" data-prompt-index="${index}" ${busy ? "disabled" : ""} rows="4">${escapeHtml(row.prompt)}</textarea>
        </div>
      `;
    })
    .join("");
}

function renderQueue(): void {
  const section = el<HTMLElement>("queueSection");
  const list = el<HTMLElement>("queueList");
  if (!session || session.tasks.length === 0) {
    section.hidden = true;
    list.innerHTML = "";
    return;
  }

  section.hidden = false;
  list.innerHTML = session.tasks
    .map((task) => {
      const extra = [
        task.imageCount ? `${task.imageCount} 张配图` : "",
        task.error ? `${task.failedPhase ?? ""} ${task.error}` : "",
      ]
        .filter(Boolean)
        .map((line) => `<div class="batch-task-sub">${escapeHtml(line)}</div>`)
        .join("");
      return `
        <div class="batch-queue-item is-${task.status === "running" ? "running" : task.status}">
          <div>
            <div class="batch-task-title">${escapeHtml(task.title)}</div>
            ${extra}
          </div>
          <div class="batch-queue-status">${escapeHtml(statusLabel(task.status))}</div>
        </div>
      `;
    })
    .join("");
}

function updateFooter(): void {
  const startBtn = el<HTMLButtonElement>("startBatchBtn");
  const confirmMergeBtn = el<HTMLButtonElement>("confirmMergeBtn");
  const discardMergeBtn = el<HTMLButtonElement>("discardMergeBtn");
  const pauseBtn = el<HTMLButtonElement>("pauseBatchBtn");
  const retryBtn = el<HTMLButtonElement>("retryBatchBtn");
  const skipBtn = el<HTMLButtonElement>("skipBatchBtn");
  const cancelBtn = el<HTMLButtonElement>("cancelBatchBtn");
  const loadBtn = el<HTMLButtonElement>("loadTasksBtn");

  const checkedCount = pickerRows.filter((row) => row.checked).length;
  const status = session?.status;
  const active = hasActiveBatchSession(session);

  confirmMergeBtn.hidden = true;
  discardMergeBtn.hidden = true;
  pauseBtn.hidden = true;
  retryBtn.hidden = true;
  skipBtn.hidden = true;
  cancelBtn.hidden = true;
  startBtn.hidden = false;

  if (!active) {
    startBtn.textContent = "开始任务";
    startBtn.disabled = loopRunning || checkedCount === 0;
    loadBtn.disabled = loopRunning;
    return;
  }

  cancelBtn.hidden = false;
  loadBtn.disabled = true;
  startBtn.hidden = true;

  switch (status) {
    case "running":
      pauseBtn.hidden = false;
      break;
    case "waiting_confirm":
    case "waiting_input":
      break;
    case "waiting_merge":
      confirmMergeBtn.hidden = false;
      discardMergeBtn.hidden = false;
      break;
    case "paused":
      retryBtn.hidden = false;
      skipBtn.hidden = false;
      break;
    default:
      startBtn.hidden = false;
      startBtn.textContent = "开始任务";
      startBtn.disabled = true;
      break;
  }
}

function buildSessionFromSelection(): TapdBatchSession | null {
  const iterationId = el<HTMLSelectElement>("iterationSelect").value;
  const iteration = iterations.find((item) => item.id === iterationId);
  if (!iterationId || !iteration) return null;

  const selected = pickerRows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.checked);
  if (selected.length === 0) return null;

  const now = new Date().toISOString();
  const tasks = selected.map(({ row }, order) =>
    createBatchTask({
      tapdTaskId: row.task.id,
      title: row.task.name,
      prompt: row.prompt.trim() || buildTaskPrompt(row.task),
      sourceHtml: row.sourceHtml || row.task.description,
      imageCount: row.task.imageCount,
      order,
    })
  );

  return {
    id: crypto.randomUUID(),
    workspaceId,
    iterationId,
    iterationName: iteration.name,
    status: "idle",
    tasks,
    createdAt: now,
    updatedAt: now,
  };
}

async function restoreBatchState(): Promise<void> {
  const storedSession = await loadTapdBatchSession();
  const data = await sendTapdBatchCommand<{ session: TapdBatchSession | null; loopRunning: boolean }>({
    type: "TAPD_BATCH_GET_STATE",
  });

  loopRunning = Boolean(data.loopRunning);
  const mergedSession = data.session ?? storedSession;
  applySession(mergedSession);

  if (hasActiveBatchSession(mergedSession)) {
    const shouldResume =
      mergedSession!.status === "running" ||
      mergedSession!.status === "waiting_confirm" ||
      mergedSession!.status === "waiting_merge" ||
      mergedSession!.status === "waiting_input";
    if (shouldResume) {
      await sendTapdBatchCommand({
        type: "TAPD_BATCH_RESUME",
        serverUrl,
      });
      const refreshed = await sendTapdBatchCommand<{ session: TapdBatchSession | null; loopRunning: boolean }>({
        type: "TAPD_BATCH_GET_STATE",
      });
      loopRunning = Boolean(refreshed.loopRunning);
      applySession(refreshed.session ?? mergedSession);
    }
  }
}

async function syncStateFromBackground(): Promise<void> {
  await restoreBatchState();
  renderTaskPicker();
}

async function loadIterations(selectSaved = true): Promise<void> {
  if (!serverUrl) {
    setStatus("请先在设置中配置服务端地址");
    return;
  }

  setStatus("正在加载迭代…");
  try {
    const result = await fetchTapdIterations(serverUrl);
    workspaceId = result.workspaceId;
    iterations = result.iterations.sort((a, b) => (b.enddate ?? "").localeCompare(a.enddate ?? ""));

    const stored = selectSaved
      ? ((await chrome.storage.local.get([SELECTED_ITERATION_KEY]))[SELECTED_ITERATION_KEY] as string | undefined)
      : undefined;
    const selectedId = stored && iterations.some((item) => item.id === stored)
      ? stored
      : pickDefaultIterationId(iterations);

    renderIterationOptions(selectedId);
    setStatus(`已加载 ${iterations.length} 个迭代`);
  } catch (err) {
    setStatus(formatErrorMessage(serverUrl, err));
  }
}

async function loadTasks(): Promise<void> {
  const iterationId = el<HTMLSelectElement>("iterationSelect").value;
  if (!iterationId || !serverUrl) return;

  await chrome.storage.local.set({ [SELECTED_ITERATION_KEY]: iterationId });
  setStatus("正在加载任务…");

  try {
    const completedIds = await listCompletedTapdTaskIds();
    const result = await fetchTapdIterationTasks(serverUrl, iterationId);
    pickerRows = result.tasks.map((task) => ({
      task,
      prompt: buildTaskPrompt(task),
      sourceHtml: task.description ?? "",
      checked: !completedIds.has(task.id),
      previouslyCompleted: completedIds.has(task.id),
    }));
    renderTaskPicker();
    setStatus(`已加载 ${pickerRows.length} 个以 ${TAPD_TASK_PREFIX} 开头的任务`);
    updateFooter();
  } catch (err) {
    setStatus(formatErrorMessage(serverUrl, err));
  }
}

async function startBatch(): Promise<void> {
  const nextSession = buildSessionFromSelection();
  if (!nextSession) {
    setStatus("请至少勾选一个任务");
    return;
  }

  progressView?.reset();
  activeProgressJobId = null;
  el<HTMLElement>("progressSection").hidden = false;

  await sendTapdBatchCommand({
    type: "TAPD_BATCH_START",
    serverUrl,
    session: nextSession,
  });
  await syncStateFromBackground();
}

function closeTapdResetConfirmModal(confirmed: boolean): void {
  const modal = document.getElementById("tapdResetConfirmModal");
  if (modal) modal.hidden = true;
  const resolver = tapdResetConfirmResolver;
  tapdResetConfirmResolver = null;
  resolver?.(confirmed);
}

function showTapdResetConfirmModal(): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = document.getElementById("tapdResetConfirmModal");
    if (!modal) {
      resolve(true);
      return;
    }
    tapdResetConfirmResolver = resolve;
    modal.hidden = false;
    document.getElementById<HTMLButtonElement>("tapdResetConfirmOk")?.focus();
  });
}

function setupTapdResetConfirmModal(): void {
  document.getElementById("tapdResetConfirmOk")?.addEventListener("click", () => {
    closeTapdResetConfirmModal(true);
  });
  document.getElementById("tapdResetConfirmCancel")?.addEventListener("click", () => {
    closeTapdResetConfirmModal(false);
  });
  document.getElementById("tapdResetConfirmBackdrop")?.addEventListener("click", () => {
    closeTapdResetConfirmModal(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const modal = document.getElementById("tapdResetConfirmModal");
    if (modal && !modal.hidden) {
      closeTapdResetConfirmModal(false);
    }
  });
}

async function resetTapdTaskPanel(): Promise<void> {
  if (hasActiveBatchSession(session) || loopRunning) {
    try {
      await sendTapdBatchCommand({ type: "TAPD_BATCH_CANCEL" });
    } catch {
      // ignore
    }
  }

  session = null;
  loopRunning = false;
  pickerRows = [];
  iterations = [];
  workspaceId = "";

  progressView?.reset();
  activeProgressJobId = null;

  el<HTMLElement>("queueSection").hidden = true;
  el<HTMLElement>("progressSection").hidden = true;
  el<HTMLElement>("taskPickerList").innerHTML = `<p class="batch-empty">请先选择迭代并加载任务</p>`;

  await Promise.all([
    saveTapdBatchSession(null),
    chrome.storage.local.remove([SELECTED_ITERATION_KEY, TAPD_BATCH_JOB_LOG]),
  ]);

  setStatus("就绪");
  updateFooter();

  await loadIterations(true);
}

async function handleRefreshClick(): Promise<void> {
  const confirmed = await showTapdResetConfirmModal();
  if (!confirmed) return;
  await resetTapdTaskPanel();
}

function bindEvents(options?: TapdBatchPanelOptions): void {
  el<HTMLButtonElement>("backToCodingBtn").addEventListener("click", () => {
    options?.onBack?.();
  });
  el<HTMLButtonElement>("batchRefreshBtn").addEventListener("click", () => {
    void handleRefreshClick();
  });
  el<HTMLButtonElement>("loadTasksBtn").addEventListener("click", () => void loadTasks());
  el<HTMLSelectElement>("iterationSelect").addEventListener("change", () => {
    pickerRows = [];
    renderTaskPicker();
    void loadTasks();
  });

  el<HTMLElement>("taskPickerList").addEventListener("change", (event) => {
    const target = event.target as HTMLElement;
    const index = target.getAttribute("data-picker-index");
    if (index == null || !(target instanceof HTMLInputElement) || target.type !== "checkbox") return;
    const row = pickerRows[Number(index)];
    if (!row) return;
    row.checked = target.checked;
    updateFooter();
  });

  el<HTMLElement>("taskPickerList").addEventListener("input", (event) => {
    const target = event.target as HTMLElement;
    const index = target.getAttribute("data-prompt-index");
    if (index == null || !(target instanceof HTMLTextAreaElement)) return;
    const row = pickerRows[Number(index)];
    if (!row) return;
    row.prompt = target.value;
  });

  el<HTMLButtonElement>("selectPendingBtn").addEventListener("click", () => {
    pickerRows = pickerRows.map((row) => ({ ...row, checked: !row.previouslyCompleted }));
    renderTaskPicker();
    updateFooter();
  });

  el<HTMLButtonElement>("clearSelectionBtn").addEventListener("click", () => {
    pickerRows = pickerRows.map((row) => ({ ...row, checked: false }));
    renderTaskPicker();
    updateFooter();
  });

  el<HTMLButtonElement>("startBatchBtn").addEventListener("click", () => void startBatch());
  el<HTMLButtonElement>("pauseBatchBtn").addEventListener("click", () => {
    void sendTapdBatchCommand({ type: "TAPD_BATCH_PAUSE" });
  });
  el<HTMLButtonElement>("retryBatchBtn").addEventListener("click", () => {
    void sendTapdBatchCommand({ type: "TAPD_BATCH_RETRY_CURRENT" }).then(() => syncStateFromBackground());
  });
  el<HTMLButtonElement>("skipBatchBtn").addEventListener("click", () => {
    void sendTapdBatchCommand({ type: "TAPD_BATCH_SKIP_CURRENT" }).then(() => syncStateFromBackground());
  });
  el<HTMLButtonElement>("cancelBatchBtn").addEventListener("click", () => {
    void sendTapdBatchCommand({ type: "TAPD_BATCH_CANCEL" }).then(() => syncStateFromBackground());
  });
  el<HTMLButtonElement>("confirmMergeBtn").addEventListener("click", () => {
    const jobId = session?.activeJobId;
    if (!jobId) return;
    void sendTapdBatchCommand<{ ok: boolean; error?: string }>({ type: "TAPD_BATCH_CONFIRM_MERGE" }).then(
      (result) => {
        if (result?.ok === false) {
          setStatus(result.error ?? "合并失败");
          return;
        }
        progressView?.renderMergeCard(jobId, "running");
        setStatus("正在合并到 test…");
      }
    );
  });
  el<HTMLButtonElement>("discardMergeBtn").addEventListener("click", () => {
    const jobId = session?.activeJobId;
    void sendTapdBatchCommand<{ ok: boolean; error?: string }>({ type: "TAPD_BATCH_DISCARD_MERGE" }).then(
      (result) => {
        if (result?.ok === false) {
          setStatus(result.error ?? "放弃合并失败");
          return;
        }
        if (jobId) progressView?.renderMergeCard(jobId, "cancelled");
        setStatus("已放弃合并");
        void syncStateFromBackground();
      }
    );
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === TAPD_BATCH_STATE) {
      applySession(message.session as TapdBatchSession | null);
      renderTaskPicker();
      void sendTapdBatchCommand<{ loopRunning: boolean }>({ type: "TAPD_BATCH_GET_STATE" }).then((data) => {
        loopRunning = Boolean(data.loopRunning);
        updateFooter();
      });
      return;
    }
    if (message?.type === TAPD_BATCH_JOB_EVENT) {
      const event = message.event as JobEvent;
      ensureProgressView().handleEvent(event);
      if (event.phase === "plan_done" && event.jobId) {
        void (async () => {
          const view = ensureProgressView();
          if (serverUrl) {
            try {
              const job = await queryJobStatus(serverUrl, event.jobId);
              if (job.planSummary?.trim()) {
                view.renderPlan(event.jobId, job.planSummary, true);
              }
            } catch {
              const summary = session?.planSummary;
              if (summary) view.renderPlan(event.jobId, summary, true);
            }
          }
          view.renderConfirmCard(event.jobId, "awaiting_confirm");
        })();
      }
      if (event.phase === "plan_need_more" && event.jobId) {
        const summary = session?.planSummary;
        if (summary) ensureProgressView().renderPlan(event.jobId, summary, false);
        ensureProgressView().renderConfirmCard(event.jobId, "awaiting_input");
      }
      if (event.phase === "execute_ready" && event.jobId) {
        ensureProgressView().renderMergeCard(event.jobId, "awaiting_merge");
        scrollProgressToBottom();
        updateFooter();
      }
    }
  });
}

async function initPanel(options?: TapdBatchPanelOptions): Promise<void> {
  const config = await loadConfig();
  serverUrl = config.serverUrl;
  setupTapdResetConfirmModal();
  bindEvents(options);
  await loadIterations();

  const storedSession = await loadTapdBatchSession();
  if (storedSession?.iterationId && iterations.some((item) => item.id === storedSession.iterationId)) {
    el<HTMLSelectElement>("iterationSelect").value = storedSession.iterationId;
  }

  const iterationId = el<HTMLSelectElement>("iterationSelect").value;
  if (iterationId) await loadTasks();

  await restoreBatchState();
  updateFooter();
}

export function initTapdBatchPanel(root: HTMLElement, options?: TapdBatchPanelOptions): void {
  if (panelInitialized) return;
  panelInitialized = true;
  panelRoot = root;
  void initPanel(options);
}
