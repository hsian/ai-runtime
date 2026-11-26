import { randomUUID } from "node:crypto";
import type { EventMessage, TemplateCard } from "@wecom/aibot-node-sdk";
import { getDatabase } from "../../services/database.js";
import { executePlannedJob } from "../../services/jobActions.js";
import { createJob, getJob, updateJob } from "../../services/jobStore.js";
import { getProject } from "../../services/projectRegistry.js";
import { requestTaskMerge } from "../../services/taskOperations.js";
import type { WecomConfig } from "./config.js";
import type { ConversationProposal } from "./directConversation.js";
import { canModifyCode } from "./permissions.js";
import { bindJob, getBinding, getSession } from "./sessionStore.js";
import type { WecomSession } from "./types.js";

const CONFIRMATION_KEY = "confirm";
const CONFIRMATION_TTL_MS = 10 * 60_000;

function ownedJob(session: WecomSession, projectId: string, jobId: string) {
  const job = getJob(jobId);
  return job?.ownerId === session.owner_id && job.projectId === projectId && job.taskMode === "code"
    && getBinding(jobId, session.session_key) ? job : undefined;
}

export function createConversationActions(options: WecomConfig, operations = { executePlannedJob, requestTaskMerge }, now = Date.now) {
  const pending = new Map<string, { session: WecomSession; projectId: string; proposal: ConversationProposal; expires: number;
    plan?: string; commit?: string; branch?: string }>();

  return {
    offer(session: WecomSession, projectId: string, proposal: ConversationProposal): { card?: TemplateCard; text: string } {
      if (!canModifyCode(options, session.user_id)) return { text: "当前账号没有代码执行或合并权限。" };
      const draft = proposal.action === "change";
      const merge = proposal.action === "merge";
      const job = draft ? undefined : ownedJob(session, projectId, proposal.jobId);
      const plan = draft ? proposal.plan : job?.planSummary;
      const commit = job?.sourceCommitSha ?? job?.commitSha;
      const branch = merge ? getProject(projectId).defaultBranch : undefined;
      if (!draft && (!job || (merge ? job.status !== "awaiting_merge" || !job.branch
        || !commit || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit) : job.status !== "awaiting_confirm" || !plan))) {
        return { text: "这个任务现在不能执行该操作，请确认任务和当前状态。" };
      }
      const id = randomUUID();
      for (const [key, value] of pending) {
        if (value.expires <= now() || value.session.session_key === session.session_key) pending.delete(key);
      }
      pending.set(id, { session: { ...session }, projectId, proposal, expires: now() + CONFIRMATION_TTL_MS, plan, commit, branch });
      const title = merge ? "确认合并" : "确认执行";
      const target = draft ? plan!.slice(0, 100) : job!.prompt.slice(0, 80);
      const text = merge ? `待确认：将「${target}」的提交 \`${commit!.slice(0, 12)}\` 合并到 \`${branch}\`。`
        : `**待确认的修改范围**\n\n${plan}`;
      return { text, card: {
        card_type: "button_interaction", task_id: id,
        main_title: { title, desc: (merge ? `${commit!.slice(0, 12)} → ${branch}` : target).slice(0, 30) },
        button_list: [{ text: title, style: 1, key: CONFIRMATION_KEY }],
      } };
    },
    clear() { pending.clear(); },
    discard(id: string) { pending.delete(id); },
    confirm(event: EventMessage): string | undefined {
      if (event.aibotid !== options.botId || event.event.eventtype !== "template_card_event"
        || event.event.event_key !== CONFIRMATION_KEY || !event.event.task_id) return;
      const id = event.event.task_id;
      const item = pending.get(id);
      if (!item) return;
      const sender = event.from?.userid;
      const target = event.chattype === "group" ? event.chatid : sender;
      if (sender !== item.session.user_id || target !== item.session.target_id) return;
      pending.delete(id);
      if (item.expires <= now()) return "这张确认卡已过期，请重新说明要处理的事项。";
      if (!canModifyCode(options, sender)) return "当前账号没有代码执行或合并权限。";
      const { projectId, proposal } = item;
      const session = getSession(options.botId, target, sender, projectId);
      if (session.conversation_id !== item.session.conversation_id) return "当前话题已变更，请重新确认操作。";
      if (proposal.action === "change") {
        const job = getDatabase().transaction(() => {
          const created = createJob({ prompt: proposal.plan, projectId, ownerId: session.owner_id,
            conversationId: session.conversation_id, submittedBy: sender, taskMode: "code" });
          updateJob(created.jobId, { status: "awaiting_confirm", requiresConfirm: true, planSummary: proposal.plan,
            requireMergeConfirmation: true, previewHost: options.previewHost });
          bindJob(session, created.jobId);
          return created;
        })();
        operations.executePlannedJob(job.jobId, session.owner_id);
        return "已确认执行。改完后会通知你，合并需要另外确认。";
      }
      const job = ownedJob(session, projectId, proposal.jobId);
      if (proposal.action === "merge") {
        if (job?.status !== "awaiting_merge" || (job.sourceCommitSha ?? job.commitSha) !== item.commit
          || getProject(projectId).defaultBranch !== item.branch) return "任务状态、提交或目标分支已变化，请重新确认。";
        operations.requestTaskMerge(job.jobId, { confirmedVersion: { commit: item.commit!, targetBranch: item.branch! } });
        return `已确认合并到 ${item.branch}，结果稍后通知你。`;
      }
      if (job?.status !== "awaiting_confirm" || job.planSummary !== item.plan) return "任务或方案已变化，请重新确认。";
      updateJob(job.jobId, { requireMergeConfirmation: true });
      operations.executePlannedJob(job.jobId, session.owner_id);
      return "已确认执行。改完后会通知你，合并需要另外确认。";
    },
  };
}
