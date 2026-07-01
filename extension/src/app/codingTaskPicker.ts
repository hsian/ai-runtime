import { deleteCodingTask, listCodingTasks } from "../shared/codingTaskStore.js";
import { loadConfig } from "../shared/config.js";
import { listJobs } from "../shared/api.js";
import type { CodingTask, JobStatus } from "../shared/types.js";
import "./task-picker.css";

export interface CodingTaskPickerOptions {
  onSelect: (task: CodingTask) => void;
  onReleaseMerge?: (job: JobStatus) => void | Promise<void>;
  onRevertDefault?: (job: JobStatus) => void | Promise<void>;
  onStatus?: (text: string) => void;
}

const DRAWER_OPEN_KEY = "taskDrawerOpen";
const DRAWER_WIDTH_KEY = "taskDrawerWidth";
const MIN_DRAWER_WIDTH = 240;
const MAX_DRAWER_WIDTH = 560;

let listEl: HTMLElement | null = null;
let shellEl: HTMLElement | null = null;
let toggleBtn: HTMLButtonElement | null = null;
let refreshBtn: HTMLButtonElement | null = null;
let drawerEl: HTMLElement | null = null;
let resizerEl: HTMLElement | null = null;
let isOpen = false;
let drawerWidth = 300;
let rafId: number | null = null;
let queuedWidth: number | null = null;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function summarize(text: string, max = 72): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function isReleaseMergeCandidate(job: JobStatus): boolean {
  return Boolean(
    job.status === "completed" &&
      job.sourceBranch &&
      job.sourceCommitSha &&
      job.mergedToDefaultBranch &&
      job.branch === job.mergedToDefaultBranch &&
      !job.revertedFromDefaultAt
  );
}

function canRevertDefault(job?: JobStatus): boolean {
  return Boolean(
    job?.status === "completed" &&
      job.mergedToDefaultBranch &&
      job.branch === job.mergedToDefaultBranch &&
      job.commitSha &&
      !job.revertedFromDefaultAt
  );
}

function latestReleaseMergeText(job: JobStatus): string {
  const latest = job.releaseMerges?.slice().sort(
    (a, b) => new Date(b.mergedAt).getTime() - new Date(a.mergedAt).getTime()
  )[0];
  if (!latest) return "待合并到发版分支";
  if (latest.status === "completed") return `已合并到 ${latest.targetBranch}`;
  return `合并到 ${latest.targetBranch} 失败`;
}

function findJobForTask(task: CodingTask, jobs: JobStatus[]): JobStatus | undefined {
  if (task.jobId) {
    const byId = jobs.find((job) => job.jobId === task.jobId);
    if (byId) return byId;
  }
  const prompt = task.rawContent || task.draftPrompt;
  return jobs.find((job) => job.status === "completed" && prompt && job.prompt === prompt);
}

function renderTaskJobMeta(job?: JobStatus): string {
  if (!job) return "";
  const branchText = job.sourceBranch
    ? `<span class="task-picker-job-line">改动分支：${escapeHtml(summarize(job.sourceBranch, 48))}</span>`
    : "";
  const defaultText = job.mergedToDefaultBranch
    ? `<span class="task-picker-job-line">已合并到：${escapeHtml(job.mergedToDefaultBranch)}</span>`
    : "";
  const releaseText = isReleaseMergeCandidate(job)
    ? `<span class="task-picker-release-status">${escapeHtml(latestReleaseMergeText(job))}</span>`
    : "";
  const revertText = job.revertedFromDefaultAt
    ? `<span class="task-picker-release-status warning">test 已撤回</span>`
    : job.revertError
      ? `<span class="task-picker-release-status danger">test 撤回失败</span>`
      : "";
  return `${branchText}${defaultText}${releaseText}${revertText}`;
}

async function renderTaskList(): Promise<void> {
  if (!listEl) return;
  refreshBtn && (refreshBtn.disabled = true);

  try {
    const [tasks, config] = await Promise.all([listCodingTasks(), loadConfig()]);
    let jobs: JobStatus[] = [];
    if (config.serverUrl) {
      try {
        jobs = await listJobs(config.serverUrl);
      } catch (err) {
        console.warn("[AI Runtime] 加载任务历史中的服务端任务失败:", err);
      }
    }

    if (tasks.length === 0) {
      listEl.innerHTML = `<div class="task-picker-empty">暂无已保存的任务</div>`;
      return;
    }

    listEl.innerHTML = tasks
      .map(
        (task) => {
          const job = findJobForTask(task, jobs);
          const canReleaseMerge = job && isReleaseMergeCandidate(job);
          const canRevert = canRevertDefault(job);
          return `
        <div class="task-picker-item" data-task-id="${escapeHtml(task.id)}">
          <button class="task-picker-select" type="button" data-task-id="${escapeHtml(task.id)}">
            <span class="task-picker-title">${escapeHtml(task.title)}</span>
            <span class="task-picker-summary">${escapeHtml(summarize(task.draftPrompt))}</span>
            ${renderTaskJobMeta(job)}
          </button>
          ${
            canReleaseMerge
              ? `<button class="task-picker-release" type="button" data-release-job-id="${escapeHtml(job.jobId)}">合并</button>`
              : ""
          }
          <div class="task-picker-more-wrap">
            <button class="task-picker-more" type="button" data-menu-task-id="${escapeHtml(task.id)}" title="更多操作">⋯</button>
            <div class="task-picker-menu" data-menu-for="${escapeHtml(task.id)}" hidden>
              ${
                canRevert && job
                  ? `<button type="button" class="task-picker-menu-item danger" data-revert-job-id="${escapeHtml(job.jobId)}">撤回 test 提交</button>`
                  : ""
              }
              <button type="button" class="task-picker-menu-item" data-delete-id="${escapeHtml(task.id)}">删除本地任务</button>
            </div>
          </div>
        </div>
      `;
        }
      )
      .join("");
  } finally {
    refreshBtn && (refreshBtn.disabled = false);
  }
}

function clampWidth(value: number): number {
  return Math.max(MIN_DRAWER_WIDTH, Math.min(MAX_DRAWER_WIDTH, Math.round(value)));
}

function applyDrawerWidth(width: number): void {
  if (!shellEl) return;
  drawerWidth = clampWidth(width);
  shellEl.style.setProperty("--task-drawer-width", `${drawerWidth}px`);
}

function queueApplyDrawerWidth(width: number): void {
  queuedWidth = width;
  if (rafId != null) return;

  rafId = requestAnimationFrame(() => {
    rafId = null;
    if (queuedWidth == null) return;
    applyDrawerWidth(queuedWidth);
    queuedWidth = null;
  });
}

function setDrawerOpen(open: boolean): void {
  if (!shellEl || !toggleBtn || !drawerEl) return;

  isOpen = open;
  shellEl.classList.toggle("task-drawer-open", open);
  toggleBtn.setAttribute("aria-expanded", open ? "true" : "false");
  drawerEl.setAttribute("aria-hidden", open ? "false" : "true");

  if (open) {
    void renderTaskList();
  }

  void chrome.storage.local.set({ [DRAWER_OPEN_KEY]: open });
}

export function refreshTaskDrawer(): void {
  if (isOpen) {
    void renderTaskList();
  }
}

export function initCodingTaskPicker(options: CodingTaskPickerOptions): void {
  shellEl = document.getElementById("chatShell");
  listEl = document.getElementById("taskDrawerList");
  toggleBtn = document.getElementById("taskDrawerToggle") as HTMLButtonElement | null;
  refreshBtn = document.getElementById("taskDrawerRefresh") as HTMLButtonElement | null;
  drawerEl = document.getElementById("taskDrawer");
  resizerEl = document.getElementById("taskDrawerResizer");

  if (!shellEl || !listEl || !toggleBtn || !drawerEl || !resizerEl) return;

  toggleBtn.addEventListener("click", () => {
    setDrawerOpen(!isOpen);
  });

  refreshBtn?.addEventListener("click", (event) => {
    event.stopPropagation();
    void renderTaskList();
  });

  resizerEl.addEventListener("pointerdown", (event) => {
    if (!isOpen) return;
    if (!shellEl) return;

    event.preventDefault();
    resizerEl!.setPointerCapture(event.pointerId);

    const startX = event.clientX;
    const startWidth = drawerWidth;
    shellEl.classList.add("task-drawer-resizing");

    const handleMove = (moveEvent: PointerEvent): void => {
      // Drawer is on the right: dragging left increases width
      const next = startWidth - (moveEvent.clientX - startX);
      queueApplyDrawerWidth(next);
    };

    const handleUp = (upEvent: PointerEvent): void => {
      try {
        resizerEl!.releasePointerCapture(upEvent.pointerId);
      } catch {
        // ignore
      }
      shellEl!.classList.remove("task-drawer-resizing");
      resizerEl!.removeEventListener("pointermove", handleMove);
      resizerEl!.removeEventListener("pointerup", handleUp);
      resizerEl!.removeEventListener("pointercancel", handleUp);
      if (rafId != null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (queuedWidth != null) {
        applyDrawerWidth(queuedWidth);
        queuedWidth = null;
      }
      void chrome.storage.local.set({ [DRAWER_WIDTH_KEY]: drawerWidth });
    };

    resizerEl!.addEventListener("pointermove", handleMove);
    resizerEl!.addEventListener("pointerup", handleUp);
    resizerEl!.addEventListener("pointercancel", handleUp);
  });

  listEl.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const menuTaskId = target.closest<HTMLElement>("[data-menu-task-id]")?.dataset.menuTaskId;
    if (menuTaskId) {
      event.stopPropagation();
      listEl!.querySelectorAll<HTMLElement>(".task-picker-menu").forEach((menu) => {
        if (menu.dataset.menuFor === menuTaskId) {
          menu.hidden = !menu.hidden;
        } else {
          menu.hidden = true;
        }
      });
      return;
    }

    const revertJobId = target.closest<HTMLElement>("[data-revert-job-id]")?.dataset.revertJobId;
    if (revertJobId) {
      event.stopPropagation();
      listEl.querySelectorAll<HTMLElement>(".task-picker-menu").forEach((menu) => {
        menu.hidden = true;
      });
      void loadConfig().then(async (config) => {
        try {
          if (!config.serverUrl) {
            options.onStatus?.("请先在设置中配置服务端地址");
            return;
          }
          const jobs = await listJobs(config.serverUrl);
          const job = jobs.find((item) => item.jobId === revertJobId);
          if (!job) {
            options.onStatus?.("任务不存在或服务已重启");
            return;
          }
          await options.onRevertDefault?.(job);
          await renderTaskList();
        } catch (err) {
          options.onStatus?.(err instanceof Error ? err.message : String(err));
        }
      });
      return;
    }

    const releaseJobId = target.closest<HTMLElement>("[data-release-job-id]")?.dataset.releaseJobId;
    if (releaseJobId) {
      event.stopPropagation();
      void loadConfig().then(async (config) => {
        try {
          if (!config.serverUrl) {
            options.onStatus?.("请先在设置中配置服务端地址");
            return;
          }
          const jobs = await listJobs(config.serverUrl);
          const job = jobs.find((item) => item.jobId === releaseJobId);
          if (!job) {
            options.onStatus?.("任务不存在或服务已重启");
            return;
          }
          await options.onReleaseMerge?.(job);
          await renderTaskList();
        } catch (err) {
          options.onStatus?.(err instanceof Error ? err.message : String(err));
          return;
        }
      });
      return;
    }

    const deleteId = target.closest<HTMLElement>("[data-delete-id]")?.dataset.deleteId;
    if (deleteId) {
      event.stopPropagation();
      listEl.querySelectorAll<HTMLElement>(".task-picker-menu").forEach((menu) => {
        menu.hidden = true;
      });
      void deleteCodingTask(deleteId).then(() => renderTaskList());
      return;
    }

    const taskId = target.closest<HTMLElement>("[data-task-id]")?.dataset.taskId;
    if (!taskId) return;

    void listCodingTasks().then((tasks) => {
      const task = tasks.find((item) => item.id === taskId);
      if (task) {
        options.onSelect(task);
      }
    });
  });

  document.addEventListener("click", (event) => {
    if (!listEl?.contains(event.target as Node)) {
      listEl?.querySelectorAll<HTMLElement>(".task-picker-menu").forEach((menu) => {
        menu.hidden = true;
      });
    }
  });

  void chrome.storage.local.get([DRAWER_OPEN_KEY]).then((stored) => {
    if (stored[DRAWER_OPEN_KEY] === true) {
      setDrawerOpen(true);
    }
  });

  void chrome.storage.local.get([DRAWER_WIDTH_KEY]).then((stored) => {
    const raw = stored[DRAWER_WIDTH_KEY];
    if (typeof raw === "number" && Number.isFinite(raw)) {
      applyDrawerWidth(raw);
    } else {
      applyDrawerWidth(drawerWidth);
    }
  });
}
