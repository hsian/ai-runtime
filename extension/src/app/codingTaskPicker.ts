import {
  deleteCodingTasksByConversation,
  listCodingTasks,
} from "../shared/codingTaskStore.js";
import {
  deleteCodingConversation,
  getActiveCodingConversation,
  listCodingConversations,
} from "../shared/codingConversationStore.js";
import { loadConfig } from "../shared/config.js";
import { listJobs } from "../shared/api.js";
import type { CodingTask, JobStatus } from "../shared/types.js";
import "./task-picker.css";

export interface CodingTaskPickerOptions {
  onSelectConversation: (conversationId: string, anchorJobId?: string) => void | Promise<void>;
  onConversationDeleted?: (nextConversationId: string) => void | Promise<void>;
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

function summarize(text: string, max = 40): string {
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

function renderChildTask(task: CodingTask, jobs: JobStatus[]): string {
  const job = findJobForTask(task, jobs);
  const canRevert = canRevertDefault(job);
  const canReleaseMerge = Boolean(job && isReleaseMergeCandidate(job));
  const canCreateBug = canCreateTapdBug(job);
  const conversationId = task.conversationId ?? "";
  const jobId = job?.jobId ?? task.jobId ?? "";
  return `
    <div class="task-picker-item task-picker-child" data-task-id="${escapeHtml(task.id)}">
      <button
        class="task-picker-select task-picker-child-select"
        type="button"
        data-conversation-id="${escapeHtml(conversationId)}"
        ${jobId ? `data-anchor-job-id="${escapeHtml(jobId)}"` : ""}
        title="${escapeHtml(task.draftPrompt)}"
      >
        <span class="task-picker-branch" aria-hidden="true">└</span>
        <span class="task-picker-summary">${escapeHtml(summarize(task.draftPrompt))}</span>
      </button>
      <div class="task-picker-actions system-context-menu" aria-label="代码任务操作">
        <button type="button" class="task-picker-action system-context-menu-item" ${
          canReleaseMerge && job ? `data-release-job-id="${escapeHtml(job.jobId)}"` : "disabled"
        }>合并</button>
        <button type="button" class="task-picker-action system-context-menu-item" ${
          canRevert && job ? `data-revert-job-id="${escapeHtml(job.jobId)}"` : "disabled"
        }>撤销</button>
        <button type="button" class="task-picker-action system-context-menu-item" ${
          canCreateBug && job ? `data-create-bug-job-id="${escapeHtml(job.jobId)}"` : "disabled"
        }>提 Bug</button>
      </div>
    </div>
  `;
}

async function renderTaskList(): Promise<void> {
  if (!listEl) return;

  const [tasks, conversations, activeConversation, config] = await Promise.all([
    listCodingTasks(),
    listCodingConversations(),
    getActiveCodingConversation(),
    loadConfig(),
  ]);
  let jobs: JobStatus[] = [];
  if (config.serverUrl) {
    try {
      jobs = await listJobs(config.serverUrl);
    } catch (err) {
      console.warn("[AI Runtime] 加载代码任务状态失败:", err);
    }
  }

  if (conversations.length === 0) {
    listEl.innerHTML = `<div class="task-picker-empty">暂无任务</div>`;
    return;
  }

  listEl.innerHTML = conversations
    .map((conversation) => {
      const children = tasks.filter((task) => task.conversationId === conversation.id);
      const activeClass = conversation.id === activeConversation.id ? " is-active" : "";
      return `
        <section class="task-picker-group${activeClass}" data-conversation-group="${escapeHtml(conversation.id)}">
          <button
            class="task-picker-parent"
            type="button"
            data-conversation-id="${escapeHtml(conversation.id)}"
            title="${escapeHtml(conversation.title)}"
          >
            <span class="task-picker-chevron" aria-hidden="true">▾</span>
            <span class="task-picker-parent-title">${escapeHtml(summarize(conversation.title, 48))}</span>
          </button>
          <button
            type="button"
            class="task-picker-parent-delete"
            data-delete-conversation-id="${escapeHtml(conversation.id)}"
            title="删除会话"
            aria-label="删除会话"
          >×</button>
          <div class="task-picker-children">
            ${children.map((task) => renderChildTask(task, jobs)).join("")}
          </div>
        </section>
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
    const child = (event.target as HTMLElement | null)?.closest<HTMLElement>(
      ".task-picker-child"
    );
    const actions = child?.querySelector<HTMLElement>(".task-picker-actions");
    if (!actions) return;

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
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hideTaskActions();
  });
  window.addEventListener("blur", hideTaskActions);

  listEl.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const deleteConversationId = target.closest<HTMLElement>(
      "[data-delete-conversation-id]"
    )?.dataset.deleteConversationId;
    if (deleteConversationId) {
      const group = target.closest<HTMLElement>(".task-picker-group");
      const title =
        group?.querySelector<HTMLElement>(".task-picker-parent-title")?.textContent?.trim() ??
        "";
      const confirmed = window.confirm(
        `确认删除会话${title ? `「${summarize(title, 24)}」` : ""}？\n\n会删除该会话及其本地任务记录，不会影响已经提交或合并的代码。`
      );
      if (!confirmed) return;
      void (async () => {
        await Promise.all([
          deleteCodingConversation(deleteConversationId),
          deleteCodingTasksByConversation(deleteConversationId),
        ]);
        const next = await getActiveCodingConversation();
        await renderTaskList();
        await options.onConversationDeleted?.(next.id);
      })();
      return;
    }

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

    const select = target.closest<HTMLElement>("[data-conversation-id]");
    const conversationId = select?.dataset.conversationId;
    if (!conversationId) return;
    void options.onSelectConversation(conversationId, select.dataset.anchorJobId);
  });

  void renderTaskList();
}
