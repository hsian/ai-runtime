import type { JobStatusType } from "./types.js";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface PlanConfirmCardHandlers {
  getPlanText: (jobId: string) => string;
  onExecute: (jobId: string, planSummary: string) => void | Promise<void>;
  onCancel: (jobId: string) => void | Promise<void>;
}

function confirmCardStatusLabel(status: JobStatusType): string {
  switch (status) {
    case "awaiting_input":
      return "需要补充信息";
    case "cancelled":
      return "已取消";
    case "completed":
      return "已执行并完成";
    case "failed":
      return "执行失败";
    case "pending":
      return "已确认，准备独立工作区";
    case "running":
      return "已确认，执行中";
    case "planning":
      return "Plan 分析中";
    default:
      return status;
  }
}

function confirmCardTitle(status: JobStatusType): string {
  switch (status) {
    case "planning":
      return "Plan 分析中，请稍候...";
    case "pending":
      return "已确认执行，准备独立工作区";
    case "running":
      return "已确认执行，正在修改";
    case "completed":
      return "执行已完成";
    case "failed":
      return "执行失败";
    case "cancelled":
      return "任务已取消";
    default:
      return "Plan 完成：是否执行修改？";
  }
}

function statusTone(status: JobStatusType): string {
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

function statusIcon(status: JobStatusType): string {
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

export function mountPlanConfirmCard(
  node: HTMLElement,
  jobId: string,
  status: JobStatusType,
  handlers: PlanConfirmCardHandlers
): void {
  const interactive = status === "awaiting_confirm" || status === "awaiting_input";
  const needsInput = status === "awaiting_input";

  if (!interactive) {
    const title = confirmCardTitle(status);
    const statusLabel = confirmCardStatusLabel(status);
    const icon = statusIcon(status);
    node.innerHTML = `
      <div class="result-card result-card--${statusTone(status)}">
        ${icon ? `<span class="result-icon" aria-hidden="true">${icon}</span>` : ""}
        <div class="result-content">
          <div class="result-title">${escapeHtml(title)}</div>
          ${statusLabel && statusLabel !== title ? `<div class="result-meta">${escapeHtml(statusLabel)}</div>` : ""}
        </div>
      </div>
    `;
    return;
  }

  node.innerHTML = `
    <div class="msg-meta">${needsInput ? "需要补充信息" : "等待确认"}</div>
    <div class="queue-card queue-card--waiting queue-card--confirm">
      <div class="queue-title">${
        needsInput
          ? "需求信息不足，请重新提交更具体的需求"
          : "Plan 完成：可编辑上方方案后执行修改"
      }</div>
      <div class="confirm-actions">
        ${
          needsInput
            ? ""
            : `<button class="primary" data-action="execute">执行修改</button>`
        }
        <button class="secondary" data-action="cancel">取消</button>
      </div>
      <div class="hint" style="margin-top:8px;">${
        needsInput
          ? "当前 Plan 信息不足，取消后请重新提交完整需求"
          : "执行时会使用上方当前方案文本；修改完成后将自动合并到 test，并提供预览地址"
      }</div>
    </div>
  `;

  const execBtn = node.querySelector<HTMLButtonElement>('[data-action="execute"]');
  const cancelBtn = node.querySelector<HTMLButtonElement>('[data-action="cancel"]');

  const setBusy = (busy: boolean): void => {
    execBtn && (execBtn.disabled = busy);
    cancelBtn && (cancelBtn.disabled = busy);
  };

  execBtn?.addEventListener("click", () => {
    void (async () => {
      const planSummary = handlers.getPlanText(jobId);
      if (!planSummary) return;
      setBusy(true);
      try {
        await handlers.onExecute(jobId, planSummary);
      } finally {
        setBusy(false);
      }
    })();
  });

  cancelBtn?.addEventListener("click", () => {
    void handlers.onCancel(jobId);
  });
}

function mergeCardStatusLabel(status: JobStatusType, useMergeRequest = false): string {
  switch (status) {
    case "running":
      return useMergeRequest ? "正在提交 Merge Request..." : "正在合并到 test...";
    case "completed":
      return useMergeRequest ? "已提交 Merge Request" : "已合并到 test";
    case "cancelled":
      return "已放弃合并";
    default:
      return status;
  }
}

export interface MergeConfirmCardHandlers {
  onMerge: (jobId: string) => void | Promise<void>;
  onDiscard: (jobId: string) => void | Promise<void>;
  createMergeRequestOnMerge?: boolean;
  previewUrl?: string;
  previewMessage?: string;
  mergeRetryable?: boolean;
}

export function mountMergeConfirmCard(
  node: HTMLElement,
  jobId: string,
  status: JobStatusType,
  handlers: MergeConfirmCardHandlers
): void {
  const interactive = status === "awaiting_merge";
  const retryable = handlers.mergeRetryable === true;
  const useMergeRequest = !retryable && handlers.createMergeRequestOnMerge === true;
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
  const previewHtml = handlers.previewUrl
    ? `<div class="hint" style="margin-top:8px;">预览地址：<a href="${escapeHtml(handlers.previewUrl)}" target="_blank" rel="noreferrer">${escapeHtml(handlers.previewUrl)}</a></div>`
    : handlers.previewMessage
      ? `<div class="hint" style="margin-top:8px;">预览状态：${escapeHtml(handlers.previewMessage)}</div>`
    : "";

  if (!interactive) {
    const statusLabel = mergeCardStatusLabel(status, useMergeRequest);
    const icon = statusIcon(status);
    node.innerHTML = `
      <div class="result-card result-card--${statusTone(status)}">
        ${icon ? `<span class="result-icon" aria-hidden="true">${icon}</span>` : ""}
        <div class="result-content">
          <div class="result-title">${escapeHtml(statusLabel)}</div>
          ${previewHtml ? `<div class="result-detail">${previewHtml}</div>` : ""}
        </div>
      </div>
    `;
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

  const mergeBtn = node.querySelector<HTMLButtonElement>('[data-action="merge"]');
  const discardBtn = node.querySelector<HTMLButtonElement>('[data-action="discard"]');

  const setBusy = (busy: boolean): void => {
    mergeBtn && (mergeBtn.disabled = busy);
    discardBtn && (discardBtn.disabled = busy);
  };

  mergeBtn?.addEventListener("click", () => {
    void (async () => {
      setBusy(true);
      try {
        await handlers.onMerge(jobId);
      } finally {
        setBusy(false);
      }
    })();
  });

  discardBtn?.addEventListener("click", () => {
    void (async () => {
      setBusy(true);
      try {
        await handlers.onDiscard(jobId);
      } finally {
        setBusy(false);
      }
    })();
  });
}
