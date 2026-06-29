import "../shared/styles.css";
import "./tapd-batch.css";
import { loadConfig } from "../shared/config.js";
import { formatErrorMessage, fetchJobEvents, queryJobStatus } from "../shared/api.js";
import { JobProgressView } from "../shared/jobProgressView.js";
import {
  buildTaskPrompt,
  fetchTapdIterationBugs,
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

type PickerKind = "task" | "bug";

interface PickerRow {
  kind: PickerKind;
  task: TapdTaskItem;
  prompt: string;
  sourceHtml: string;
  checked: boolean;
  previouslyCompleted: boolean;
}

let serverUrl = "";
let workspaceId = "";
let iterations: TapdIteration[] = [];
let activePickerKind: PickerKind = "task";
const pickerRowsByKind: Record<PickerKind, PickerRow[]> = {
  task: [],
  bug: [],
};
let pickerRows: PickerRow[] = pickerRowsByKind.task;
let session: TapdBatchSession | null = null;
let loopRunning = false;
let progressView: JobProgressView | null = null;
let activeProgressJobId: string | null = null;
let createMergeRequestOnMerge = false;
const expandedPromptTaskIds = new Set<string>();

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

function pickerKindLabel(kind: PickerKind = activePickerKind): string {
  return kind === "bug" ? "BUG" : "任务";
}

function completedKeyFor(kind: PickerKind, id: string): string {
  return kind === "bug" ? `bug:${id}` : id;
}

function setActivePickerRows(rows: PickerRow[]): void {
  pickerRowsByKind[activePickerKind] = rows;
  pickerRows = rows;
}

function switchPickerKind(kind: PickerKind): void {
  activePickerKind = kind;
  pickerRows = pickerRowsByKind[kind];
}

function clearPickerRows(): void {
  pickerRowsByKind.task = [];
  pickerRowsByKind.bug = [];
  pickerRows = pickerRowsByKind[activePickerKind];
  expandedPromptTaskIds.clear();
}

function updateSelectionSummary(): void {
  const checkedCount = pickerRows.filter((row) => row.checked).length;
  const totalCount = pickerRows.length;
  const summary = panelRoot?.querySelector<HTMLElement>("#taskSelectionSummary");
  if (summary) {
    summary.textContent = totalCount
      ? `已选 ${checkedCount} / ${totalCount} 个${pickerKindLabel()}`
      : `未加载${pickerKindLabel()}`;
  }

  const footerSummary = panelRoot?.querySelector<HTMLElement>("#batchFooterSummary");
  if (footerSummary) {
    footerSummary.textContent = totalCount
      ? `已选 ${checkedCount} 个，共 ${totalCount} 个`
      : "已选 0 个";
  }
}

function updateSideEmptyState(): void {
  const sideEmpty = panelRoot?.querySelector<HTMLElement>("#batchSideEmpty");
  const queueVisible = !el<HTMLElement>("queueSection").hidden;
  const progressVisible = !el<HTMLElement>("progressSection").hidden;
  if (sideEmpty) sideEmpty.hidden = queueVisible || progressVisible;
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
      createMergeRequestOnMerge,
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
  updateSideEmptyState();

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
  updateSideEmptyState();
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
      updateSideEmptyState();
      setStatus("就绪");
    } else if (next.status === "cancelled" || next.status === "completed") {
      setStatus(next.pauseReason ?? sessionStatusLabel(next.status));
      ensureProgressView().clearGateCards();
      updateSideEmptyState();
    }
    return;
  }

  setStatus(next!.pauseReason ?? sessionStatusLabel(next!.status));
  el<HTMLElement>("queueSection").hidden = false;
  updateSideEmptyState();

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
    container.innerHTML = `<p class="batch-empty">当前迭代没有以 ${TAPD_TASK_PREFIX} 开头的${pickerKindLabel()}</p>`;
    updateSelectionSummary();
    return;
  }

  const executionOrderByIndex = new Map<number, number>();
  let executionOrder = 0;
  pickerRows.forEach((row, index) => {
    if (!row.checked) return;
    executionOrder += 1;
    executionOrderByIndex.set(index, executionOrder);
  });

  container.innerHTML = pickerRows
    .map((row, index) => {
      const badge = [
        row.checked ? `<span class="batch-badge order">第 ${executionOrderByIndex.get(index)} 个执行</span>` : "",
        row.previouslyCompleted ? `<span class="batch-badge done">曾执行</span>` : "",
        (row.task.imageCount ?? 0) > 0
          ? `<span class="batch-badge">${row.task.imageCount} 张配图</span>`
          : "",
      ].join("");
      const owner = row.task.owner ? ` · ${escapeHtml(row.task.owner)}` : "";
      const status = row.task.status ? ` · ${escapeHtml(row.task.status)}` : "";
      const moveUpDisabled = busy || index === 0 ? "disabled" : "";
      const moveDownDisabled = busy || index === pickerRows.length - 1 ? "disabled" : "";
      const promptKey = `${row.kind}:${row.task.id}`;
      const expanded = expandedPromptTaskIds.has(promptKey);
      return `
        <div class="batch-task-item${row.previouslyCompleted ? " is-done" : ""}" data-tapd-task-id="${escapeHtml(row.task.id)}">
          <div class="batch-task-head">
            <input type="checkbox" data-picker-index="${index}" ${row.checked ? "checked" : ""} ${busy ? "disabled" : ""} />
            <div class="batch-task-meta">
              <div class="batch-task-title batch-task-title-toggle" data-prompt-toggle-index="${index}" data-expanded="${expanded ? "true" : "false"}">
                ${escapeHtml(row.task.name)}${badge}
              </div>
              <div class="batch-task-sub">#${escapeHtml(row.task.id)}${owner}${status}</div>
            </div>
            <div class="batch-task-order-controls" aria-label="调整执行顺序">
              <button class="batch-order-btn" type="button" data-move-index="${index}" data-move-direction="-1" title="上移" aria-label="上移任务" ${moveUpDisabled}>
                <svg class="batch-order-icon" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M4 10l4-4 4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
              <button class="batch-order-btn" type="button" data-move-index="${index}" data-move-direction="1" title="下移" aria-label="下移任务" ${moveDownDisabled}>
                <svg class="batch-order-icon" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
            </div>
          </div>
          <div class="batch-prompt-details"${expanded ? "" : " hidden"}>
            <textarea class="batch-prompt" data-prompt-index="${index}" ${busy ? "disabled" : ""} rows="4">${escapeHtml(row.prompt)}</textarea>
          </div>
        </div>
      `;
    })
    .join("");
  updateSelectionSummary();
}

function getTaskPickerRects(): Map<string, DOMRect> {
  const rects = new Map<string, DOMRect>();
  el<HTMLElement>("taskPickerList")
    .querySelectorAll<HTMLElement>(".batch-task-item[data-tapd-task-id]")
    .forEach((node) => {
      const taskId = node.dataset.tapdTaskId;
      if (taskId) rects.set(taskId, node.getBoundingClientRect());
    });
  return rects;
}

function animateTaskPickerReorder(previousRects: Map<string, DOMRect>): void {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const movedNodes: HTMLElement[] = [];
  el<HTMLElement>("taskPickerList")
    .querySelectorAll<HTMLElement>(".batch-task-item[data-tapd-task-id]")
    .forEach((node) => {
      const taskId = node.dataset.tapdTaskId;
      const previousRect = taskId ? previousRects.get(taskId) : undefined;
      if (!previousRect) return;

      const nextRect = node.getBoundingClientRect();
      const deltaX = previousRect.left - nextRect.left;
      const deltaY = previousRect.top - nextRect.top;
      if (deltaX === 0 && deltaY === 0) return;

      node.style.transition = "none";
      node.style.transform = `translate(${deltaX}px, ${deltaY}px)`;
      movedNodes.push(node);
    });

  if (movedNodes.length === 0) return;

  requestAnimationFrame(() => {
    movedNodes.forEach((node) => {
      node.style.transition = "transform 180ms ease";
      node.style.transform = "";
      node.addEventListener(
        "transitionend",
        () => {
          node.style.transition = "";
        },
        { once: true }
      );
    });
  });
}

function movePickerRow(index: number, direction: -1 | 1): void {
  if (isBatchBusy()) return;
  const nextIndex = index + direction;
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    nextIndex < 0 ||
    index >= pickerRows.length ||
    nextIndex >= pickerRows.length
  ) {
    return;
  }

  const previousRects = getTaskPickerRects();
  const nextRows = [...pickerRows];
  [nextRows[index], nextRows[nextIndex]] = [nextRows[nextIndex], nextRows[index]];
  setActivePickerRows(nextRows);
  renderTaskPicker();
  updateFooter();
  animateTaskPickerReorder(previousRects);
}

function renderQueue(): void {
  const section = el<HTMLElement>("queueSection");
  const list = el<HTMLElement>("queueList");
  if (!session || session.tasks.length === 0) {
    section.hidden = true;
    list.innerHTML = "";
    updateSideEmptyState();
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
  updateSideEmptyState();
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
  const loadBugsBtn = el<HTMLButtonElement>("loadBugsBtn");

  const checkedCount = pickerRows.filter((row) => row.checked).length;
  const status = session?.status;
  const active = hasActiveBatchSession(session);
  const terminalBatch = status === "cancelled" || status === "completed";

  confirmMergeBtn.hidden = true;
  confirmMergeBtn.textContent = createMergeRequestOnMerge ? "提交 Merge Request" : "合并到 test";
  discardMergeBtn.hidden = true;
  pauseBtn.hidden = true;
  retryBtn.hidden = true;
  skipBtn.hidden = true;
  cancelBtn.hidden = true;
  startBtn.hidden = false;
  updateSelectionSummary();
  updateSideEmptyState();

  if (!active) {
    startBtn.textContent = "开始执行";
    startBtn.disabled = loopRunning || checkedCount === 0;
    loadBtn.disabled = loopRunning && !terminalBatch;
    loadBugsBtn.disabled = loopRunning && !terminalBatch;
    return;
  }

  cancelBtn.hidden = false;
  loadBtn.disabled = true;
  loadBugsBtn.disabled = true;
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
      startBtn.textContent = "开始执行";
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
      tapdTaskId: completedKeyFor(row.kind, row.task.id),
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

async function loadTapdItems(kind: PickerKind): Promise<void> {
  const iterationId = el<HTMLSelectElement>("iterationSelect").value;
  if (!iterationId || !serverUrl) return;

  await chrome.storage.local.set({ [SELECTED_ITERATION_KEY]: iterationId });
  switchPickerKind(kind);
  renderTaskPicker();
  setStatus(`正在加载${pickerKindLabel(kind)}…`);

  try {
    const completedIds = await listCompletedTapdTaskIds();
    const items = kind === "bug"
      ? (await fetchTapdIterationBugs(serverUrl, iterationId)).bugs
      : (await fetchTapdIterationTasks(serverUrl, iterationId)).tasks;
    setActivePickerRows(items.map((task) => ({
      kind,
      task,
      prompt: buildTaskPrompt(task),
      sourceHtml: task.description ?? "",
      checked: !completedIds.has(completedKeyFor(kind, task.id)),
      previouslyCompleted: completedIds.has(completedKeyFor(kind, task.id)),
    })));
    renderTaskPicker();
    setStatus(`已加载 ${pickerRows.length} 个以 ${TAPD_TASK_PREFIX} 开头的${pickerKindLabel(kind)}`);
    updateFooter();
  } catch (err) {
    setStatus(formatErrorMessage(serverUrl, err));
  }
}

async function loadTasks(): Promise<void> {
  await loadTapdItems("task");
}

async function loadBugs(): Promise<void> {
  await loadTapdItems("bug");
}

async function startBatch(): Promise<void> {
  const nextSession = buildSessionFromSelection();
  if (!nextSession) {
    setStatus(`请至少勾选一个${pickerKindLabel()}`);
    return;
  }

  progressView?.reset();
  activeProgressJobId = null;
  el<HTMLElement>("progressSection").hidden = false;
  updateSideEmptyState();

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
    (document.getElementById("tapdResetConfirmOk") as HTMLButtonElement | null)?.focus();
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
  clearPickerRows();
  iterations = [];
  workspaceId = "";

  progressView?.reset();
  activeProgressJobId = null;

  el<HTMLElement>("queueSection").hidden = true;
  el<HTMLElement>("progressSection").hidden = true;
  updateSideEmptyState();
  el<HTMLElement>("taskPickerList").innerHTML = `<p class="batch-empty">请先选择迭代并加载任务或 BUG</p>`;
  updateSelectionSummary();

  await Promise.all([
    saveTapdBatchSession(null),
    chrome.storage.local.remove([SELECTED_ITERATION_KEY, TAPD_BATCH_JOB_LOG]),
  ]);

  setStatus("就绪");
  updateFooter();

  await loadIterations(true);
}

function setWorkbenchTaskWidth(percent: number): void {
  const workbench = panelRoot?.querySelector<HTMLElement>(".batch-workbench");
  if (!workbench) return;
  const next = Math.min(62, Math.max(28, percent));
  workbench.style.setProperty("--batch-task-width", `${next.toFixed(1)}%`);
}

function setupWorkbenchResize(): void {
  const resizer = panelRoot?.querySelector<HTMLElement>("#batchWorkbenchResizer");
  const workbench = panelRoot?.querySelector<HTMLElement>(".batch-workbench");
  if (!resizer || !workbench) return;

  const getPercentFromClientX = (clientX: number): number => {
    const rect = workbench.getBoundingClientRect();
    if (rect.width <= 0) return 40;
    return ((clientX - rect.left) / rect.width) * 100;
  };

  resizer.addEventListener("pointerdown", (event) => {
    if (window.matchMedia("(max-width: 920px)").matches) return;
    event.preventDefault();
    resizer.setPointerCapture(event.pointerId);
    document.body.classList.add("batch-resizing");
    setWorkbenchTaskWidth(getPercentFromClientX(event.clientX));
  });

  resizer.addEventListener("pointermove", (event) => {
    if (!resizer.hasPointerCapture(event.pointerId)) return;
    setWorkbenchTaskWidth(getPercentFromClientX(event.clientX));
  });

  const stopResize = (event: PointerEvent): void => {
    if (resizer.hasPointerCapture(event.pointerId)) {
      resizer.releasePointerCapture(event.pointerId);
    }
    document.body.classList.remove("batch-resizing");
  };

  resizer.addEventListener("pointerup", stopResize);
  resizer.addEventListener("pointercancel", stopResize);

  resizer.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const current =
      Number.parseFloat(workbench.style.getPropertyValue("--batch-task-width").replace("%", "")) || 40;
    setWorkbenchTaskWidth(current + (event.key === "ArrowLeft" ? -2 : 2));
  });
}

async function handleRefreshClick(): Promise<void> {
  const confirmed = await showTapdResetConfirmModal();
  if (!confirmed) return;
  await resetTapdTaskPanel();
}

function bindEvents(options?: TapdBatchPanelOptions): void {
  setupWorkbenchResize();

  el<HTMLButtonElement>("backToCodingBtn").addEventListener("click", () => {
    options?.onBack?.();
  });
  el<HTMLButtonElement>("batchRefreshBtn").addEventListener("click", () => {
    void handleRefreshClick();
  });
  el<HTMLButtonElement>("loadTasksBtn").addEventListener("click", () => void loadTasks());
  el<HTMLButtonElement>("loadBugsBtn").addEventListener("click", () => void loadBugs());
  el<HTMLSelectElement>("iterationSelect").addEventListener("change", () => {
    clearPickerRows();
    switchPickerKind("task");
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
    renderTaskPicker();
    updateFooter();
  });

  el<HTMLElement>("taskPickerList").addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const toggle = target.closest<HTMLElement>("[data-prompt-toggle-index]");
    if (toggle) {
      event.preventDefault();
      const row = pickerRows[Number(toggle.getAttribute("data-prompt-toggle-index"))];
      if (!row) return;
      const promptKey = `${row.kind}:${row.task.id}`;
      if (expandedPromptTaskIds.has(promptKey)) {
        expandedPromptTaskIds.delete(promptKey);
      } else {
        expandedPromptTaskIds.add(promptKey);
      }
      renderTaskPicker();
      return;
    }

    const button = target.closest<HTMLButtonElement>("button[data-move-index]");
    if (!button) return;

    event.preventDefault();
    const index = Number(button.getAttribute("data-move-index"));
    const direction = button.getAttribute("data-move-direction") === "-1" ? -1 : 1;
    movePickerRow(index, direction);
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
    setActivePickerRows(pickerRows.map((row) => ({ ...row, checked: !row.previouslyCompleted })));
    renderTaskPicker();
    updateFooter();
  });

  el<HTMLButtonElement>("clearSelectionBtn").addEventListener("click", () => {
    setActivePickerRows(pickerRows.map((row) => ({ ...row, checked: false })));
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
        setStatus(createMergeRequestOnMerge ? "正在提交 Merge Request…" : "正在合并到 test…");
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
      if (typeof message.loopRunning === "boolean") {
        loopRunning = message.loopRunning;
      }
      applySession(message.session as TapdBatchSession | null);
      renderTaskPicker();
      if (typeof message.loopRunning === "boolean") {
        updateFooter();
        return;
      }
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
  createMergeRequestOnMerge = config.createMergeRequestOnMerge;
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
