import type { JobEvent, JobStatusType } from "./types.js";
import { mountPlanConfirmCard, mountMergeConfirmCard } from "./planConfirmCard.js";

const PLAN_KEY = "plan-result";
const CONFIRM_KEY = "confirm-card";
const MERGE_KEY = "merge-card";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return "";
  }
}

export interface JobProgressViewOptions {
  onStatus?: (text: string) => void;
  onConfirmExecute?: (jobId: string, planSummary: string) => void;
  onPlanReply?: (jobId: string, reply: string) => void;
  onCancelJob?: (jobId: string) => void;
  onConfirmMerge?: (jobId: string) => void;
  onDiscardMerge?: (jobId: string) => void;
  createMergeRequestOnMerge?: boolean;
}

export class JobProgressView {
  private planBuffers = new Map<string, string>();
  private agentBuffers = new Map<string, string>();
  private seenEventIds = new Set<string>();

  constructor(
    private container: HTMLElement,
    private options: JobProgressViewOptions = {}
  ) {}

  reset(): void {
    this.container.innerHTML = "";
    this.planBuffers.clear();
    this.agentBuffers.clear();
    this.seenEventIds.clear();
  }

  getPlanText(jobId: string): string {
    const node = this.container.querySelector<HTMLTextAreaElement>(`[data-plan-job="${jobId}"]`);
    if (node) return node.value.trim();
    return this.planBuffers.get(jobId)?.trim() ?? "";
  }

  private ensure(key: string, className: string): HTMLElement {
    let node = this.container.querySelector<HTMLElement>(`[data-key="${key}"]`);
    if (!node) {
      node = document.createElement("div");
      node.className = className;
      node.dataset.key = key;
      this.container.appendChild(node);
    }
    return node;
  }

  private scrollToBottom(): void {
    this.container.scrollTop = this.container.scrollHeight;
  }

  renderPlan(jobId: string, summary: string, editable = false): void {
    if (!summary.trim()) return;
    this.planBuffers.set(jobId, summary);
    const node = this.ensure(`${PLAN_KEY}-${jobId}`, "msg msg-agent msg-plan-result");
    node.innerHTML = `
      <div class="msg-meta">Plan 方案</div>
      <textarea class="plan-edit msg-bubble" data-plan-job="${jobId}" rows="10"${editable ? "" : " readonly"}>${escapeHtml(summary)}</textarea>
    `;
    this.scrollToBottom();
  }

  renderConfirmCard(jobId: string, status: JobStatusType): void {
    const node = this.ensure(`${CONFIRM_KEY}-${jobId}`, "msg msg-queue");
    mountPlanConfirmCard(node, jobId, status, {
      getPlanText: (id) => this.getPlanText(id),
      onExecute: (id, planSummary) => {
        this.options.onConfirmExecute?.(id, planSummary);
      },
      onPlanReply: (id, reply) => {
        this.options.onPlanReply?.(id, reply);
      },
      onCancel: (id) => {
        this.options.onCancelJob?.(id);
      },
    });
    this.scrollToBottom();
  }

  renderMergeCard(jobId: string, status: JobStatusType): void {
    const node = this.ensure(`${MERGE_KEY}-${jobId}`, "msg msg-queue");
    mountMergeConfirmCard(node, jobId, status, {
      onMerge: (id) => {
        this.options.onConfirmMerge?.(id);
      },
      onDiscard: (id) => {
        this.options.onDiscardMerge?.(id);
      },
      createMergeRequestOnMerge: this.options.createMergeRequestOnMerge,
    });
    this.scrollToBottom();
  }

  clearGateCards(): void {
    this.container
      .querySelectorAll<HTMLElement>(`[data-key^="${CONFIRM_KEY}"], [data-key^="${MERGE_KEY}"]`)
      .forEach((node) => node.remove());
  }

  handleEvent(event: JobEvent): void {
    if (this.seenEventIds.has(event.id)) return;
    this.seenEventIds.add(event.id);

    switch (event.type) {
      case "stage":
        if (event.text) {
          const node = document.createElement("div");
          node.className = "msg msg-stage";
          node.dataset.key = event.id;
          node.textContent = event.text;
          this.container.appendChild(node);
        }
        if (event.phase === "plan_done") {
          this.options.onStatus?.("等待确认执行");
        } else if (event.phase === "plan_need_more") {
          this.options.onStatus?.("需要补充信息");
          if (event.jobId) this.renderConfirmCard(event.jobId, "awaiting_input");
        } else if (event.phase === "execute_ready") {
          this.options.onStatus?.("等待确认合并");
          if (event.jobId) this.renderMergeCard(event.jobId, "awaiting_merge");
        } else if (event.phase === "plan") {
          this.options.onStatus?.("Plan 分析中");
        } else if (event.phase === "merge") {
          this.options.onStatus?.("正在合并到 test");
        } else if (event.phase === "merge_request") {
          this.options.onStatus?.("正在提交 Merge Request");
        } else if (event.phase && ["pull", "branch", "agent", "commit"].includes(event.phase)) {
          this.options.onStatus?.("执行中");
        }
        break;
      case "agent_text":
        if (!event.delta) break;
        {
          const key = `agent-${event.jobId}`;
          const prev = this.agentBuffers.get(event.jobId) ?? "";
          const next = prev + event.delta;
          this.agentBuffers.set(event.jobId, next);
          const node = this.ensure(key, "msg msg-agent");
          node.innerHTML = `<div class="msg-meta">Agent</div><div class="msg-bubble">${escapeHtml(next)}</div>`;
        }
        break;
      case "agent_tool":
        if (!event.text) break;
        {
          const node = document.createElement("div");
          node.className = "msg msg-tool";
          node.dataset.key = event.id;
          node.textContent = event.text;
          this.container.appendChild(node);
        }
        break;
      case "agent_status":
        if (event.statusText ?? event.text) {
          const node = this.ensure(`agent-status-${event.jobId}`, "msg msg-tool");
          node.textContent = event.statusText ?? event.text ?? "";
          this.options.onStatus?.(event.statusText ?? event.text ?? "");
        }
        break;
      case "done": {
        const node = document.createElement("div");
        node.className = "msg msg-done";
        node.dataset.key = event.id;
        node.innerHTML = `<div class="msg-meta">${formatTime(event.timestamp)}</div><div class="msg-bubble">${escapeHtml(event.message ?? "任务完成")}</div>`;
        this.container.appendChild(node);
        this.options.onStatus?.("任务已完成");
        break;
      }
      case "error": {
        const node = document.createElement("div");
        node.className = "msg msg-error";
        node.dataset.key = event.id;
        node.innerHTML = `<div class="msg-meta">${formatTime(event.timestamp)}</div><div class="msg-bubble">${escapeHtml(event.message ?? event.text ?? "任务失败")}</div>`;
        this.container.appendChild(node);
        this.options.onStatus?.("任务失败");
        break;
      }
      case "cancelled": {
        const node = document.createElement("div");
        node.className = "msg msg-cancelled";
        node.dataset.key = event.id;
        node.innerHTML = `<div class="msg-meta">${formatTime(event.timestamp)}</div><div class="msg-bubble">${escapeHtml(event.message ?? "任务已取消")}</div>`;
        this.container.appendChild(node);
        this.options.onStatus?.("任务已取消");
        break;
      }
      default:
        break;
    }
    this.scrollToBottom();
  }

  syncSessionState(input: {
    jobId?: string;
    planSummary?: string;
    status: JobStatusType | "waiting_confirm" | "waiting_merge" | "waiting_input";
  }): void {
    if (!input.jobId) return;
    if (input.planSummary) {
      this.renderPlan(input.jobId, input.planSummary, input.status === "waiting_confirm");
    }
    if (input.status === "waiting_confirm") {
      this.renderConfirmCard(input.jobId, "awaiting_confirm");
      this.options.onStatus?.("等待确认执行");
    } else if (input.status === "waiting_input") {
      this.renderConfirmCard(input.jobId, "awaiting_input");
      this.options.onStatus?.("需要补充信息");
    } else if (input.status === "waiting_merge") {
      this.renderMergeCard(input.jobId, "awaiting_merge");
      this.options.onStatus?.("等待确认合并");
    }
  }
}
