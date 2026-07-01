import { deleteCodingTask, listCodingTasks } from "../shared/codingTaskStore.js";
import { loadConfig } from "../shared/config.js";
import { listJobs } from "../shared/api.js";
import type { CodingTask, JobStatus } from "../shared/types.js";
import "./task-picker.css";

export interface CodingTaskPickerOptions {
  onSelect: (task: CodingTask) => void;
  onReleaseMerge?: (job: JobStatus) => void | Promise<void>;
  onStatus?: (text: string) => void;
}

const DRAWER_OPEN_KEY = "taskDrawerOpen";
const DRAWER_WIDTH_KEY = "taskDrawerWidth";
const MIN_DRAWER_WIDTH = 240;
const MAX_DRAWER_WIDTH = 560;

let listEl: HTMLElement | null = null;
let shellEl: HTMLElement | null = null;
let toggleBtn: HTMLButtonElement | null = null;
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
      job.branch === job.mergedToDefaultBranch
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
  return `${branchText}${defaultText}${releaseText}`;
}

async function renderTaskList(): Promise<void> {
  if (!listEl) return;

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
          <button class="task-picker-delete" type="button" data-delete-id="${escapeHtml(task.id)}" title="删除">×</button>
        </div>
      `;
      }
    )
    .join("");
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
  drawerEl = document.getElementById("taskDrawer");
  resizerEl = document.getElementById("taskDrawerResizer");

  if (!shellEl || !listEl || !toggleBtn || !drawerEl || !resizerEl) return;

  toggleBtn.addEventListener("click", () => {
    setDrawerOpen(!isOpen);
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
