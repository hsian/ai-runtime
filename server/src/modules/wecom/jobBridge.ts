import { getDatabase } from "../../services/database.js";
import { createJob, getJob, updateJob } from "../../services/jobStore.js";
import { appendJobEvent } from "../../services/jobEvents.js";
import { cancelOwnedJob, executePlannedJob, resumePlannedJob, runQueuedPlan, runQuestion } from "../../services/jobActions.js";
import { confirmJobMerge, discardJobMerge, revertCompletedJobFromDefaultBranch } from "../../services/jobMergeService.js";
import { jobQueue } from "../../services/jobQueue.js";
import { config } from "../../config.js";
import { logOperation } from "../../services/operationLog.js";
import type { Job } from "../../types.js";
import type { WecomConfig } from "./config.js";
import type { WecomSession } from "./types.js";
import type { Command } from "./commands.js";
import { bindJob, getBinding, listBindings, rememberMessage, resetSession, silenceJobNotices } from "./sessionStore.js";
import { listTopics, selectTopic } from "./topicStore.js";
import { formatJob, HELP } from "./replies.js";
import { isNonActionablePlanInput } from "../../services/agent/planInputGuard.js";
import { getTopicTapd } from "./tapdStore.js";
import { copyJobAttachments, deleteJobAttachments } from "../../services/uploadService.js";
import { getDialogue, setDialogue } from "./dialogueStore.js";
import { milestoneSignature, splitMessage } from "./replies.js";
import { queueNotice, pendingNotices, acknowledgeChunk } from "./sessionStore.js";
import { canModifyCode, requireCommandPermission } from "./permissions.js";

function acknowledgeMilestone(job: Job, session: WecomSession): void {
  const signature = milestoneSignature(job);
  if (!signature) return;
  queueNotice(job.jobId, signature, session.target_id, splitMessage(formatJob(job)));
  for (const notice of pendingNotices().filter(notice => notice.job_id === job.jobId && notice.signature === signature)) {
    const chunks = JSON.parse(notice.chunks) as string[];
    acknowledgeChunk(notice.id, chunks.length, chunks.length);
  }
}

function currentJob(session: WecomSession, jobId?: string): Job {
  const id = jobId ?? session.active_job_id;
  if (!id || !getBinding(id, session.session_key)) throw new Error("当前会话没有这个任务，请先发送需求。");
  const job = getJob(id);
  if (!job || job.ownerId !== session.owner_id) throw new Error("任务不存在。");
  return job;
}

export async function cleanupObsoletePlan(session: WecomSession, job: Job): Promise<boolean> {
  if (job.ownerId !== session.owner_id || !getBinding(job.jobId, session.session_key)
    || job.status !== "awaiting_input" || job.clarificationHistory?.length
    || !isNonActionablePlanInput(job.prompt)) return false;
  // Persist suppression before cancellation emits events or startup reconciliation runs.
  silenceJobNotices(job.jobId);
  await cancelOwnedJob(job.jobId, session.owner_id);
  return true;
}

export function parseAnswers(job: Job, text: string): { questionId: string; value: string }[] {
  const questions = job.clarificationQuestions ?? [];
  if (questions.length === 1) {
    return [{ questionId: questions[0].id, value: text.replace(/^1[.、：:]\s*/, "").trim() }];
  }
  const numbered = new Map<number, string>();
  let index: number | undefined;
  for (const line of text.split(/\r?\n/)) {
    const match = /^(\d+)[.、：:]\s*(.*)$/.exec(line.trim());
    if (match) { index = Number(match[1]); numbered.set(index, match[2]); }
    else if (index !== undefined) numbered.set(index, `${numbered.get(index)}\n${line}`);
  }
  if (!numbered.size) throw new Error("请按编号逐行回答，例如：1. 答案一\n2. 答案二");
  return questions.flatMap((question, i) => numbered.has(i + 1)
    ? [{ questionId: question.id, value: numbered.get(i + 1)! }] : []);
}

export async function dispatchCommand(session: WecomSession, command: Command, messageKey: string, options: WecomConfig,
  onJob?: (jobId: string) => void): Promise<string> {
  requireCommandPermission(session, command, options);
  if (command.action === "plan" || command.action === "question") {
    const previous = session.active_job_id ? getJob(session.active_job_id) : undefined;
    if (previous) await cleanupObsoletePlan(session, previous);
  }
  if (command.topicId) selectTopic(session, command.topicId, command.topicTitle);
  if (command.action === "clarify" && command.jobId) {
    const job = currentJob(session, command.jobId);
    if (job.conversationId) selectTopic(session, job.conversationId);
  }
  if (["execute", "cancel", "status"].includes(command.action) && "jobId" in command && command.jobId) {
    const job = currentJob(session, command.jobId);
    if (job.conversationId) selectTopic(session, job.conversationId);
  }
  if (command.action === "chat") { rememberMessage(messageKey); return command.reply; }
  if (command.action === "auto") throw new Error("消息尚未完成意图识别。");
  if (command.action === "identity") {
    rememberMessage(messageKey);
    return session.target_id === session.user_id
      ? `你的企微用户 ID：\`${session.user_id}\`\n当前权限：${canModifyCode(options, session.user_id) ? "问答和修改代码" : "仅问答"}`
      : "请私聊机器人发送「我的ID」，避免在群内公开你的用户标识。";
  }
  if (["execute", "cancel"].includes(command.action) && !command.topicId && !("jobId" in command && command.jobId)) {
    const topics = listTopics(session);
    const waitingReverts = topics.filter(topic => getDialogue({ ...session, conversation_id: topic.id })?.step === "revert_confirm");
    if (waitingReverts.length) {
      const pending = topics.filter(topic => topic.activeTask && (command.action === "execute"
        ? topic.activeTask.status === "awaiting_confirm" : !["completed", "failed", "cancelled"].includes(topic.activeTask.status)));
      if (waitingReverts.length + pending.length > 1) throw new Error("有多个话题等待处理，请指定任务：\n"
        + [...waitingReverts, ...pending].map(topic => `${topic.title}\n任务：${getDialogue({ ...session, conversation_id: topic.id })?.sourceJobId ?? topic.activeTask?.jobId}`).join("\n\n")
        + "\n发送「执行 任务编号」或「取消 任务编号」。");
      selectTopic(session, waitingReverts[0].id);
    }
  }
  const dialogue = getDialogue(session);
  if (command.action === "revert") {
    const requestedId = command.jobId;
    const candidates = listBindings().filter(binding => binding.session_key === session.session_key)
      .map(binding => getJob(binding.job_id)).filter((job): job is Job => Boolean(job
        && job.ownerId === session.owner_id && job.conversationId === session.conversation_id
        && job.status === "completed" && job.taskMode !== "question" && job.commitSha
        && job.mergedToDefaultBranch && !job.revertedFromDefaultAt
        && job.branch === job.mergedToDefaultBranch && (!requestedId || requestedId === job.jobId)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const source = candidates[0];
    if (!source) throw new Error("这个话题没有可撤回的已合并修改，请说明要撤回哪次修改。");
    setDialogue(session, { step: "revert_confirm", sourceJobId: source.jobId });
    rememberMessage(messageKey);
    return `将使用 Git revert 撤回「${source.prompt.slice(0, 120)}」，生成反向提交并沿用原合并分支，不会重新改代码模拟撤回。\n\n回复「执行」确认撤回，或「取消」保留原修改。`;
  }
  if (dialogue?.step === "reverting" && ["execute", "cancel", "status"].includes(command.action)) {
    rememberMessage(messageKey);
    return "正在使用 Git revert 撤回，结果稍后通知你。";
  }
  if (dialogue?.step === "revert_confirm" && ["execute", "cancel", "status"].includes(command.action)
    && (!("jobId" in command && command.jobId) || ("jobId" in command && command.jobId === dialogue.sourceJobId))) {
    const source = currentJob(session, dialogue.sourceJobId);
    if (command.action === "status") {
      rememberMessage(messageKey);
      return "正在等待撤回确认，将使用 Git revert。回复「执行」确认，或「取消」。";
    }
    if (command.action === "cancel") {
      setDialogue(session);
      rememberMessage(messageKey);
      return "已取消撤回，原修改保留。";
    }
    if (source.status !== "completed" || source.revertedFromDefaultAt) throw new Error("原修改已不可撤回，请重新查询状态。");
    setDialogue(session, { ...dialogue, step: "reverting" });
    rememberMessage(messageKey);
    onJob?.(source.jobId);
    jobQueue.enqueue(source.jobId, async id => {
      try { await revertCompletedJobFromDefaultBranch(id); }
      catch (error) {
        if (!getJob(id)?.revertError) updateJob(id, { revertError: error instanceof Error ? error.message : "撤回失败" });
      }
      finally {
        setDialogue(session);
        appendJobEvent(id, { type: "stage", text: "撤回处理结束" });
      }
    });
    return "Thinking...";
  }
  if (command.action === "help") { rememberMessage(messageKey); return HELP; }
  if (command.action === "topics") {
    rememberMessage(messageKey);
    const entries = listTopics(session).filter(topic => topic.activeTask || topic.tapd).slice(0, 12);
    return entries.length ? entries.map(topic => `${topic.current ? "当前话题：" : "话题："}${topic.title}\n`
      + (topic.activeTask ? `状态：${topic.activeTask.status}\n任务：${topic.activeTask.jobId}`
        : `已关联 TAPD：${topic.tapd!.itemId}，尚未创建任务。`)).join("\n\n")
      + "\n\n发送「状态 任务编号」可以回到对应话题。" : "目前还没有项目话题，直接发送问题或需求即可。";
  }
  const topicIds = new Set(listTopics(session).map(topic => topic.id));
  const unfinished = listBindings().filter(binding => binding.session_key === session.session_key)
    .map(binding => getJob(binding.job_id)).filter((job): job is Job => Boolean(job
      && job.ownerId === session.owner_id && job.conversationId && topicIds.has(job.conversationId)
      && !["completed", "failed", "cancelled"].includes(job.status)));
  if (["execute", "cancel", "merge", "discard", "clarify"].includes(command.action)
    && !("jobId" in command && command.jobId) && !command.topicId) {
    const candidates = unfinished.filter(job => command.action === "execute" ? job.status === "awaiting_confirm"
      : command.action === "merge" || command.action === "discard" ? job.status === "awaiting_merge"
      : command.action === "clarify" ? job.status === "awaiting_input" : true);
    if (candidates.length > 1) throw new Error("有多个任务可处理，请明确指定，避免操作错任务：\n"
      + candidates.map(job => `${job.prompt.slice(0, 80)}\n任务：${job.jobId}`).join("\n\n")
      + (command.action === "clarify" ? "\n请发送「补充 任务编号：答案」。" : "\n请发送命令和完整任务编号。"));
    if (candidates.length === 1) {
      command = { ...command, jobId: candidates[0].jobId } as Command;
      if (candidates[0].conversationId !== session.conversation_id) selectTopic(session, candidates[0].conversationId!);
    }
  }
  if (command.action === "new") {
    if (unfinished.length) {
      throw new Error("当前任务尚未结束，请先处理或取消，再开启新会话。");
    }
    getDatabase().transaction(() => { resetSession(session); rememberMessage(messageKey); })();
    return "已开启新会话，默认项目为 " + options.projectId + "。";
  }
  if (command.action === "plan" || command.action === "question" || command.action === "clarify") {
    if (!command.text.trim() || command.text.length > 50_000) throw new Error("需求不能为空，且不能超过 50000 字符。");
    let active = session.active_job_id ? getJob(session.active_job_id) : undefined;
    if (command.action !== "clarify" && active && await cleanupObsoletePlan(session, active)) {
      active = getJob(active.jobId);
    }
    if ((command.action === "plan" || command.action === "question") && !command.topicId) {
      selectTopic(session, "new", command.text.slice(0, 120));
      active = undefined;
    }
    if (command.action === "clarify") {
      const job = currentJob(session, command.jobId);
      const answers = parseAnswers(job, command.text);
      onJob?.(job.jobId);
      getDatabase().transaction(() => {
        resumePlannedJob(job.jobId, session.owner_id, answers);
        rememberMessage(messageKey);
      })();
      return "Thinking...";
    }
    if (active && !["completed", "failed", "cancelled"].includes(active.status)
      && !(command.action === "question" && ["awaiting_input", "awaiting_confirm"].includes(active.status))) {
      throw new Error(`当前任务尚未结束：${active.jobId}。请回复「状态」「执行」或「取消」。`);
    }
    const question = command.action === "question";
    const tapd = getTopicTapd(session);
    const job = getDatabase().transaction(() => {
      const created = createJob({ prompt: command.text, projectId: options.projectId,
        tapdContext: tapd?.context,
        ownerId: session.owner_id, conversationId: session.conversation_id,
        submittedBy: session.user_id, taskMode: question ? "question" : "code" });
      let attachments;
      try { attachments = tapd ? copyJobAttachments(created.jobId, tapd.attachments) : undefined; }
      catch (error) {
        void deleteJobAttachments(created.jobId).catch(() => console.warn("[WeCom] 未提交任务的配图清理失败"));
        throw error;
      }
      updateJob(created.jobId, { status: question ? "running" : "planning", requiresConfirm: !question, attachments,
        previewHost: options.previewHost });
      bindJob(session, created.jobId, !(question && active && ["awaiting_input", "awaiting_confirm"].includes(active.status)));
      rememberMessage(messageKey);
      appendJobEvent(created.jobId, { type: "user", text: command.text });
      return created;
    })();
    logOperation({ action: "job_submit", status: "success", jobId: job.jobId,
      ownerId: session.owner_id, mode: question ? "question" : "plan", engine: config.AGENT_PROVIDER });
    onJob?.(job.jobId);
    if (question) void runQuestion(job.jobId, {
      responseInstructions: "这是企业微信对话，请直接回答本次问题，优先简短结论。用户要求只给颜色、数字或简答时严格遵守。不要输出任务跟踪、TaskCreate、工具使用说明或内部模式限制，不要求用户切换网页模式。只有用户需要比较方案时才列选项，选项用独立行 A：、B：标注，选方案不等于确认执行。",
    });
    else void runQueuedPlan(job.jobId);
    return "Thinking...";
  }
  const job = currentJob(session, "jobId" in command ? command.jobId : undefined);
  if (job.conversationId && job.conversationId !== session.conversation_id) selectTopic(session, job.conversationId);
  if (command.action === "status") { rememberMessage(messageKey); return formatJob(job); }
  if (command.action === "execute") {
    if (job.status !== "awaiting_confirm") throw new Error("当前任务不可执行，请先完成计划确认。");
    onJob?.(job.jobId);
    getDatabase().transaction(() => { executePlannedJob(job.jobId, session.owner_id); rememberMessage(messageKey); })();
    return "Thinking...";
  }
  if (command.action === "cancel") {
    await cancelOwnedJob(job.jobId, session.owner_id);
    acknowledgeMilestone(getJob(job.jobId)!, session);
    rememberMessage(messageKey);
    return "任务已取消。";
  }
  if (job.status !== "awaiting_merge") throw new Error("当前任务不需要合并处理。");
  const discard = command.action === "discard";
  onJob?.(job.jobId);
  getDatabase().transaction(() => {
    updateJob(job.jobId, { status: "pending", message: discard ? "已请求放弃合并" : "已请求重试合并", mergeRetryable: false });
    rememberMessage(messageKey);
  })();
  const worker = async (id: string) => {
    try {
      if (discard) await discardJobMerge(id);
      else await confirmJobMerge(id);
    } catch (error) {
      updateJob(id, { status: "failed", error: String(error), message: "合并处理失败" });
      appendJobEvent(id, { type: "error", text: "合并处理失败" });
    }
  };
  if (jobQueue.enqueueGateContinuation(job.jobId, worker) === null) jobQueue.enqueue(job.jobId, worker);
  return "Thinking...";
}
