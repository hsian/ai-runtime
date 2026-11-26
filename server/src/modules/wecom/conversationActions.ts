import { randomUUID } from "node:crypto";
import type { EventMessage, TemplateCard } from "@wecom/aibot-node-sdk";
import { getDatabase } from "../../services/database.js";
import { cancelOwnedJob, executePlannedJob } from "../../services/jobActions.js";
import { getJobEvents } from "../../services/jobEvents.js";
import { createJob, getJob, updateJob } from "../../services/jobStore.js";
import { getProject } from "../../services/projectRegistry.js";
import { logOperation } from "../../services/operationLog.js";
import { requestTaskMerge } from "../../services/taskOperations.js";
import type { Job } from "../../types.js";
import type { WecomConfig } from "./config.js";
import type { ConversationProposal } from "./directConversation.js";
import { canModifyCode } from "./permissions.js";
import { ReleaseBranchNotFoundError, releaseConversationJob } from "./releaseMerge.js";
import { bindJob, getBinding, getSession } from "./sessionStore.js";
import type { WecomSession } from "./types.js";

const CONFIRMATION_KEY = "confirm";
const CANCEL_KEY = "cancel";
const CONFIRMATION_TTL_MS = 10 * 60_000;

export function readConfirmationClick(event: EventMessage) {
  if (event.event?.eventtype !== "template_card_event") return;
  const payload = event.event as typeof event.event & {
    template_card_event?: { event_key?: string; task_id?: string };
  };
  const nested = payload.template_card_event;
  if (nested && ((nested.event_key && payload.event_key && nested.event_key !== payload.event_key)
    || (nested.task_id && payload.task_id && nested.task_id !== payload.task_id))) return;
  return {
    eventKey: nested?.event_key ?? payload.event_key,
    taskId: nested?.task_id ?? payload.task_id,
  };
}

export function parseConfirmationButton(key: string | undefined) {
  const match = key?.match(/^(confirm|cancel)_([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/);
  return match ? { action: match[1], id: match[2] } : undefined;
}

function ownedJob(session: WecomSession, projectId: string, jobId: string) {
  const job = getJob(jobId);
  return job?.ownerId === session.owner_id && job.projectId === projectId && job.taskMode === "code"
    && getBinding(jobId, session.session_key) ? job : undefined;
}

function releaseReady(job: Job | undefined, defaultBranch: string): job is Job {
  return Boolean(job && job.status === "completed" && job.mergedToDefaultAt && job.mergedToDefaultBranch === defaultBranch
    && job.branch === defaultBranch && job.conversationId && job.sourceBranch && !job.revertedFromDefaultAt
    && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(job.sourceCommitSha ?? ""));
}

export function createConversationActions(options: WecomConfig, operations: {
  executePlannedJob: typeof executePlannedJob;
  requestTaskMerge: typeof requestTaskMerge;
  cancelOwnedJob?: typeof cancelOwnedJob;
  releaseConversationJob?: typeof releaseConversationJob;
} = { executePlannedJob, requestTaskMerge }, now = Date.now) {
  const pending = new Map<string, { session: WecomSession; projectId: string; proposal: ConversationProposal; expires: number;
    plan?: string; commit?: string; branch?: string; startedJobId?: string }>();
  const releasesInFlight = new Set<string>();

  return {
    offer(session: WecomSession, projectId: string, proposal: ConversationProposal, message = ""): { card?: TemplateCard; text: string } {
      if (!canModifyCode(options, session.user_id)) return { text: "当前账号没有代码执行或合并权限。" };
      const draft = proposal.action === "change";
      const release = proposal.action === "release";
      const merge = proposal.action === "merge" || release;
      const job = draft ? undefined : ownedJob(session, projectId, proposal.jobId);
      const plan = draft ? proposal.plan : job?.planSummary;
      const commit = job?.sourceCommitSha ?? job?.commitSha;
      const project = getProject(projectId);
      const branch = release ? proposal.targetBranch : merge ? project.defaultBranch : undefined;
      if (release) {
        const mentioned: string[] = message.match(/[a-zA-Z0-9_./-]+/g) ?? [];
        if (!mentioned.includes(proposal.targetBranch) || !/^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/.test(proposal.targetBranch)) {
          return { text: "请在这条消息中写出要合并到的完整分支名。" };
        }
        if (!releaseReady(job, project.defaultBranch)) return { text: "这项任务尚未合并到默认分支，或已撤回，不能合并到其他分支。" };
        if (proposal.targetBranch === project.defaultBranch || job.releaseMerges?.some(record =>
          record.targetBranch === proposal.targetBranch && record.status === "completed")) {
          return { text: `这次修改已合并到 ${proposal.targetBranch}，无需重复合并。` };
        }
        if (proposal.targetBranch === job.sourceBranch) return { text: "目标不能是本次改动的任务分支。" };
      } else if (!draft && (!job || (merge ? job.status !== "awaiting_merge" || !job.branch
        || !commit || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit) : job.status !== "awaiting_confirm" || !plan))) {
        return { text: "这个任务现在不能执行该操作，请确认任务和当前状态。" };
      }
      const id = randomUUID();
      for (const [key, value] of pending) {
        if (value.startedJobId) {
          const status = getJob(value.startedJobId)?.status;
          if (status !== "pending" && status !== "running") pending.delete(key);
        } else if (value.expires <= now() || value.session.session_key === session.session_key) pending.delete(key);
      }
      pending.set(id, { session: { ...session }, projectId, proposal, expires: now() + CONFIRMATION_TTL_MS, plan, commit, branch });
      const title = release ? "确认合并到指定分支" : merge ? "确认合并" : "确认执行";
      const target = draft ? plan!.slice(0, 100) : job!.prompt.slice(0, 80);
      const text = merge ? `待确认：将「${target}」的提交 \`${commit!.slice(0, 12)}\` 合并到 \`${branch}\`。`
        : `**待确认的修改范围**\n\n${plan}${project.autoMerge ? `\n\n执行成功后会自动合并到 \`${project.defaultBranch}\`。` : ""}`;
      return { text, card: {
        card_type: "button_interaction", task_id: id,
        main_title: { title, desc: (merge ? `${commit!.slice(0, 12)} → ${branch}` : target).slice(0, 30) },
        button_list: [
          { text: merge ? "确认合并" : title, style: 1, key: `${CONFIRMATION_KEY}_${id}` },
          { text: "取消", style: 2, key: `${CANCEL_KEY}_${id}` },
        ],
      } };
    },
    clear() { pending.clear(); },
    discard(id: string) { pending.delete(id); },
    confirm(event: EventMessage, onIgnored?: (reason: string) => void,
      onStarted?: (jobId: string, target: string) => void,
      onRelease?: (target: string, completion: Promise<string>) => void): string | Promise<void> | undefined {
      const ignore = (reason: string) => { onIgnored?.(reason); return undefined; };
      if (event.event?.eventtype !== "template_card_event") return ignore("unexpected_event");
      if (event.aibotid && event.aibotid !== options.botId) return ignore("bot_mismatch");
      const click = readConfirmationClick(event);
      if (!click) return ignore("conflicting_card_payload");
      const button = parseConfirmationButton(click.eventKey);
      if (!button) return ignore(click.eventKey ? "unknown_button_key" : "missing_button_key");
      const { action, id } = button;
      const item = pending.get(id);
      if (!item) return ignore("confirmation_not_pending");
      const eventCardId = click.taskId;
      if (eventCardId && eventCardId !== id && pending.has(eventCardId)) return ignore("card_id_conflict");
      const sender = event.from?.userid;
      if (sender !== item.session.user_id) return ignore(sender ? "sender_mismatch" : "missing_sender");
      const target = item.session.target_id;
      const isGroup = target !== item.session.user_id;
      if (isGroup ? event.chattype === "single" || event.chatid !== target
        : event.chattype === "group" || (!event.chattype && event.chatid && event.chatid !== sender)) {
        return ignore("chat_mismatch");
      }
      if (item.startedJobId) {
        if (action !== CANCEL_KEY) return ignore("execution_already_started");
        if (!canModifyCode(options, sender)) return "当前账号没有代码执行权限。";
        const job = ownedJob(item.session, item.projectId, item.startedJobId);
        if (!job || (job.status !== "pending" && job.status !== "running")) {
          pending.delete(id);
          return "这次执行已经结束，不能再取消。";
        }
        if (getJobEvents(job.jobId).some(entry => entry.type === "stage" && (entry.phase === "commit" || entry.phase === "merge"))) {
          return "已进入提交或合并阶段，不能再取消。";
        }
        pending.delete(id);
        return (operations.cancelOwnedJob ?? cancelOwnedJob)(job.jobId, item.session.owner_id, { workerOwnsCleanup: true });
      }
      pending.delete(id);
      if (item.expires <= now()) return "这张确认卡已过期，请重新说明要处理的事项。";
      if (action === CANCEL_KEY) return item.proposal.action === "merge" || item.proposal.action === "release"
        ? "已取消本次确认，没有开始合并。" : "已取消本次确认，没有开始执行。";
      if (!canModifyCode(options, sender)) return "当前账号没有代码执行或合并权限。";
      const { projectId, proposal } = item;
      const session = getSession(options.botId, target, sender, projectId);
      if (session.conversation_id !== item.session.conversation_id) return "当前话题已变更，请重新确认操作。";
      const project = getProject(projectId);
      const executionReply = project.autoMerge ? "已确认执行。"
        : "已确认执行。改完后会通知你，合并需要另外确认。";
      if (proposal.action === "change") {
        const job = getDatabase().transaction(() => {
          const created = createJob({ prompt: proposal.plan, projectId, ownerId: session.owner_id,
            conversationId: session.conversation_id, submittedBy: sender, taskMode: "code" });
          updateJob(created.jobId, { status: "awaiting_confirm", requiresConfirm: true, planSummary: proposal.plan,
            conversationHistory: undefined, requireMergeConfirmation: !project.autoMerge });
          bindJob(session, created.jobId);
          return created;
        })();
        operations.executePlannedJob(job.jobId, session.owner_id);
        pending.set(id, { ...item, startedJobId: job.jobId });
        onStarted?.(job.jobId, target);
        return executionReply;
      }
      const job = ownedJob(session, projectId, proposal.jobId);
      if (proposal.action === "release") {
        if (!releaseReady(job, project.defaultBranch) || job.sourceCommitSha !== item.commit) {
          return "源提交已变化或已撤回，请重新确认。";
        }
        const targetBranch = proposal.targetBranch;
        const key = JSON.stringify([job.jobId, targetBranch]);
        if (releasesInFlight.has(key)) return `这次修改正在合并到 ${targetBranch}，请等结果。`;
        releasesInFlight.add(key);
        const service = operations.releaseConversationJob ?? releaseConversationJob;
        const completion = Promise.resolve().then(() => service({ ...session, conversation_id: job.conversationId! },
          { jobId: job.jobId, targetBranch, expectedSourceCommit: item.commit }, options)).catch(error => {
          logOperation({ action: "wecom_release_merge", status: "failed", jobId: job.jobId, targetBranch, error: String(error) });
          return error instanceof ReleaseBranchNotFoundError ? error.message : `合并到 ${targetBranch} 未完成，请查看任务或服务日志。`;
        }).finally(() => { releasesInFlight.delete(key); });
        onRelease?.(target, completion);
        return `已确认合并到 ${targetBranch}，结果稍后通知你。`;
      }
      if (proposal.action === "merge") {
        if (job?.status !== "awaiting_merge" || (job.sourceCommitSha ?? job.commitSha) !== item.commit
          || getProject(projectId).defaultBranch !== item.branch) return "任务状态、提交或目标分支已变化，请重新确认。";
        operations.requestTaskMerge(job.jobId, { confirmedVersion: { commit: item.commit!, targetBranch: item.branch! } });
        onStarted?.(job.jobId, target);
        return `已确认合并到 ${item.branch}，结果稍后通知你。`;
      }
      if (job?.status !== "awaiting_confirm" || job.planSummary !== item.plan) return "任务或方案已变化，请重新确认。";
      updateJob(job.jobId, { requireMergeConfirmation: !project.autoMerge });
      operations.executePlannedJob(job.jobId, session.owner_id);
      pending.set(id, { ...item, startedJobId: job.jobId });
      onStarted?.(job.jobId, target);
      return executionReply;
    },
  };
}
