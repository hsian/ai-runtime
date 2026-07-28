import { deleteCodingTask, listCodingTasks } from "../shared/codingTaskStore.js";
import { loadConfig } from "../shared/config.js";
import { listJobs } from "../shared/api.js";
import type { CodingTask, JobStatus } from "../shared/types.js";
import "./task-picker.css";

export interface CodingTaskPickerOptions {
  onSelect: (task: CodingTask) => void;
  onReleaseMerge?: (job: JobStatus) => void | Promise<void>;
  onRevertDefault?: (job: JobStatus) => void | Promise<void>;
  onCreateTapdBug?: (job: JobStatus) => void | Promise<void>;
  onStatus?: (text: string) => void;
}

let listEl: HTMLElement | null = null;
let pickerOptions: CodingTaskPickerOptions | null = null;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function summarize(text: string, max = 120): string {
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

function canCreateTapdBug(job?: JobStatus): boolean {
  return Boolean(job?.jobId && job.planSummary?.trim());
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

function findJobForTask(task: CodingTask, jobs: JobStatus[]): JobStatus | undefined {
  if (task.jobId) {
    const byId = jobs.find((job) => job.jobId === task.jobId);
    if (byId) return byId;
  }
  const prompt = task.rawContent || task.draftPrompt;
  return jobs.find((job) => job.status === "completed" && prompt && job.prompt === prompt);
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
    listEl.innerHTML = `<div class="task-picker-empty">暂无历史任务</div>`;
    return;
  }

  listEl.innerHTML = tasks
    .map((task) => {
      const job = findJobForTask(task, jobs);
      const canRevert = canRevertDefault(job);
      const canReleaseMerge = Boolean(job && isReleaseMergeCandidate(job));
      const canCreateBug = canCreateTapdBug(job);
      return `
          <div class="task-picker-item" data-task-id="${escapeHtml(task.id)}">
            <button class="task-picker-select" type="button" data-select-task-id="${escapeHtml(task.id)}" title="${escapeHtml(task.draftPrompt)}">
              <span class="task-picker-summary">${escapeHtml(summarize(task.draftPrompt))}</span>
            </button>
            <div class="task-picker-actions" aria-label="任务操作">
              <button type="button" class="task-picker-action" ${
                canRevert && job ? `data-revert-job-id="${escapeHtml(job.jobId)}"` : "disabled"
              }>撤回</button>
              <button type="button" class="task-picker-action" ${
                canReleaseMerge && job ? `data-release-job-id="${escapeHtml(job.jobId)}"` : "disabled"
              }>合并</button>
              <button type="button" class="task-picker-action" ${
                canCreateBug && job ? `data-create-bug-job-id="${escapeHtml(job.jobId)}"` : "disabled"
              }>提BUG</button>
              <button type="button" class="task-picker-action" data-delete-id="${escapeHtml(task.id)}">删除</button>
            </div>
          </div>
        `;
    })
    .join("");
}

async function findServerJob(jobId: string): Promise<JobStatus | null> {
  if (!pickerOptions) return null;
  const config = await loadConfig();
  if (!config.serverUrl) {
    pickerOptions.onStatus?.("请先在设置中配置服务端地址");
    return null;
  }
  const jobs = await listJobs(config.serverUrl);
  const job = jobs.find((item) => item.jobId === jobId);
  if (!job) pickerOptions.onStatus?.("任务不存在或服务已重启");
  return job ?? null;
}

async function runJobAction(
  jobId: string,
  action: ((job: JobStatus) => void | Promise<void>) | undefined
): Promise<void> {
  if (!pickerOptions) return;
  try {
    const job = await findServerJob(jobId);
    if (!job) return;
    await action?.(job);
    await renderTaskList();
  } catch (err) {
    pickerOptions.onStatus?.(err instanceof Error ? err.message : String(err));
  }
}

export function refreshTaskDrawer(): void {
  void renderTaskList();
}

export function initCodingTaskPicker(options: CodingTaskPickerOptions): void {
  pickerOptions = options;
  listEl = document.getElementById("taskDrawerList");
  if (!listEl) return;

  let activeActions: HTMLElement | null = null;

  const hideTaskActions = (): void => {
    activeActions?.classList.remove("is-open");
    activeActions = null;
  };

  listEl.addEventListener("contextmenu", (event) => {
    const item = (event.target as HTMLElement | null)?.closest<HTMLElement>(".task-picker-item");
    const actions = item?.querySelector<HTMLElement>(".task-picker-actions");
    if (!item || !actions) return;

    event.preventDefault();
    hideTaskActions();
    activeActions = actions;
    actions.classList.add("is-open");

    const padding = 8;
    const maxX = Math.max(padding, window.innerWidth - actions.offsetWidth - padding);
    const maxY = Math.max(padding, window.innerHeight - actions.offsetHeight - padding);
    actions.style.left = `${Math.max(padding, Math.min(event.clientX, maxX))}px`;
    actions.style.top = `${Math.max(padding, Math.min(event.clientY, maxY))}px`;
  });

  listEl.addEventListener("scroll", hideTaskActions);
  document.addEventListener("click", hideTaskActions);
  document.addEventListener("contextmenu", (event) => {
    if (!(event.target as HTMLElement | null)?.closest(".task-picker-item")) {
      hideTaskActions();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hideTaskActions();
  });
  window.addEventListener("blur", hideTaskActions);

  listEl.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const createBugJobId = target.closest<HTMLElement>("[data-create-bug-job-id]")?.dataset.createBugJobId;
    if (createBugJobId) {
      void runJobAction(createBugJobId, options.onCreateTapdBug);
      return;
    }

    const revertJobId = target.closest<HTMLElement>("[data-revert-job-id]")?.dataset.revertJobId;
    if (revertJobId) {
      void runJobAction(revertJobId, options.onRevertDefault);
      return;
    }

    const releaseJobId = target.closest<HTMLElement>("[data-release-job-id]")?.dataset.releaseJobId;
    if (releaseJobId) {
      void runJobAction(releaseJobId, options.onReleaseMerge);
      return;
    }

    const deleteId = target.closest<HTMLElement>("[data-delete-id]")?.dataset.deleteId;
    if (deleteId) {
      const summary = target
        .closest<HTMLElement>(".task-picker-item")
        ?.querySelector<HTMLElement>(".task-picker-summary")
        ?.textContent
        ?.trim();
      const confirmed = window.confirm(
        `确认删除本地任务${summary ? `「${summarize(summary, 24)}」` : ""}？\n\n只会删除任务历史记录，不会影响代码或服务端任务。`
      );
      if (confirmed) void deleteCodingTask(deleteId).then(() => renderTaskList());
      return;
    }

    const taskId = target.closest<HTMLElement>("[data-select-task-id]")?.dataset.selectTaskId;
    if (!taskId) return;
    void listCodingTasks().then((tasks) => {
      const task = tasks.find((item) => item.id === taskId);
      if (task) options.onSelect(task);
    });
  });

  void renderTaskList();
}
