import { getJob } from "../../services/jobStore.js";
import { getBinding, getChatHistory, getConversationHistory, listBindings } from "./sessionStore.js";
import type { WecomSession } from "./types.js";
import type { Command } from "./commands.js";
import type { Job } from "../../types.js";
import { listSessionJobs, topicCandidates } from "./topicStore.js";
import { getDialogue, setDialogue } from "./dialogueStore.js";
import { formatJob } from "./replies.js";
import { classifyWithAgent, routeConversation, type IntentModel } from "../../services/conversationIntent.js";
export { classifyWithAgent, type IntentModel } from "../../services/conversationIntent.js";
import { redactSensitiveText } from "../../services/operationLog.js";
import { getTaskState } from "@ai-runtime/shared/task-state";

export const PROJECT_ONLY_REPLY = "我主要协助处理项目需求、代码、问题排查、测试用例和任务流程。这个问题与项目无关，暂不回答。请告诉我需要处理的项目问题。";

const taskStatusLabels: Partial<Record<Job["status"], string>> = {
  cancelled: "已取消", failed: "失败", awaiting_confirm: "待确认执行",
  awaiting_input: "待补充", awaiting_merge: "待合并", pending: "排队中",
};

function taskStatus(item: Job): string {
  return `「${item.prompt.slice(0, 80)}」${taskStatusLabels[item.status] ?? getTaskState(item).conversationStatus}`;
}

export async function resolveIntent(command: Command, session: WecomSession, model: IntentModel = classifyWithAgent): Promise<Command> {
  if (command.action !== "auto" && command.action !== "question" && command.action !== "plan" && command.action !== "test-case") return command;
  const explicit = command.action !== "auto";
  let text = command.text.trim();
  let contextSession = command.topicId ? { ...session, conversation_id: command.topicId } : session;
  if (/^[A-Z]$/i.test(text) && !command.topicId) {
    const pending = topicCandidates(session).filter(topic => getDialogue({ ...session, conversation_id: topic.id })?.step === "selection");
    if (pending.length > 1) return { action: "chat", reply: "有多个话题正在等待选择，请带上话题名称和选项，避免选错。" };
    if (pending.length === 1) contextSession = { ...session, conversation_id: pending[0].id, active_job_id: pending[0].activeTask?.jobId ?? null };
  }
  const dialogue = getDialogue(contextSession);
  const selection = dialogue?.step === "selection" && /^[A-Z]$/i.test(text)
    ? dialogue.choices?.find(choice => choice.id === text.toUpperCase()) : undefined;
  if (selection) text = `用户选择方案 ${selection.id}：${selection.text}\n原问题与方案：${dialogue?.question}`;
  if (!text || text.length > 50_000) return { action: "chat", reply: "请发送不超过 50000 字符的文字消息。" };
  const job = contextSession.active_job_id ? getJob(contextSession.active_job_id) : undefined;
  const active = job?.ownerId === session.owner_id ? job : undefined;
  try {
    const available = topicCandidates(session);
    const topics = command.topicId ? available.filter(topic => topic.id === command.topicId) : available;
    if (command.topicId && !topics.length) throw new Error("Unknown linked topic");
    const mergeCandidates = listBindings().filter(binding => binding.session_key === session.session_key)
      .map(binding => getJob(binding.job_id)).filter((item): item is Job => Boolean(item && item.ownerId === session.owner_id && item.taskMode === "code"
        && !item.revertedFromDefaultAt && topics.some(topic => topic.id === item.conversationId)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30)
      .map(item => ({ jobId: item.jobId, topicId: item.conversationId, prompt: item.prompt.slice(0, 600), status: item.status,
        mergedToDefaultBranch: item.mergedToDefaultBranch, commitSha: item.sourceCommitSha || item.commitSha }));
    const sessionJobs = listSessionJobs(session);
    const taskCandidates = explicit ? undefined : sessionJobs.slice(0, 30).map(item => ({
      jobId: item.jobId, topicId: item.conversationId,
      status: taskStatusLabels[item.status] ?? getTaskState(item).conversationStatus, title: item.prompt.slice(0, 120),
    }));
    const payload = { message: text, mergeCandidates, scopePolicy: "project-only", wecomTaskControls: explicit ? undefined : true, taskCandidates,
      requestedAction: explicit ? command.action : undefined,
      history: getConversationHistory(contextSession).map(turn => ({ role: turn.role, content: turn.content.slice(0, 600) })),
      lastQuestion: active?.clarificationQuestions ?? (selection ? dialogue?.question : undefined),
      topics: topics.map(topic => ({ id: topic.id, title: topic.title, current: topic.current,
        tapd: topic.tapd ? { title: topic.tapd.title, itemId: topic.tapd.itemId, description: topic.tapd.description.slice(0, 600) } : undefined,
        questions: topic.activeTask?.questions?.slice(0, 2),
        history: getChatHistory({ ...session, conversation_id: topic.id }).filter(turn => turn.role === "user")
          .slice(-2).map(turn => ({ role: turn.role, content: turn.content.slice(0, 600) })),
        userGoal: topic.activeTask?.prompt.slice(0, 600) })),
      linkedTopicId: command.topicId, selectionTopicId: selection ? contextSession.conversation_id : undefined };
    const result = await routeConversation(payload, model);
    if (result.intent === "off-topic") {
      return { action: "chat", reply: PROJECT_ONLY_REPLY, scopeRejected: true };
    }
    // Explicit task types remain authoritative after the scope check; model output cannot change them.
    if (explicit && result.intent !== "uncertain") return command;
    if (result.intent === "chat" || result.intent === "uncertain") {
      if (!result.reply.trim()) throw new Error("Empty reply");
      return { action: "chat", reply: result.reply.trim() };
    }
    if (result.intent === "cancel" || result.intent === "task-status") {
      const scope = command.topicId ?? result.topicId;
      const taskRows = (command.topicId || result.taskScope !== "all") && scope
        ? sessionJobs.filter(item => item.conversationId === scope) : sessionJobs;
      const selected = result.jobId ? taskRows.find(item => item.jobId === result.jobId) : undefined;
      if (result.jobId && !selected) return { action: "chat", reply: "当前会话找不到所指的任务，请提供正确的任务名称或编号。" };
      if (result.intent === "task-status") {
        if (!selected && result.taskScope !== "all" && result.relation === "uncertain") {
          return { action: "chat", reply: "你想查哪项任务的状态？请告诉我任务名称。" };
        }
        const items = selected ? [selected] : result.taskScope === "all" ? taskRows.slice(0, 12) : taskRows.slice(0, 1);
        const lines = items.map(taskStatus);
        if (result.taskScope === "all" && !selected && taskRows.length) {
          const busy = taskRows.filter(item => getTaskState(item).busy).length;
          const cancelled = taskRows.filter(item => item.status === "cancelled").length;
          lines.unshift(`当前 ${busy} 项正在处理或排队，${cancelled} 项已取消。`);
        }
        if (result.taskScope === "all" && taskRows.length > items.length) lines.push(`另有 ${taskRows.length - items.length} 项任务，可通过 /话题 查看。`);
        return { action: "chat", historySource: "task", reply: lines.join("\n") || "当前范围内没有任务记录。" };
      }
      if (result.taskScope === "all" && !result.jobId && result.relation !== "uncertain") {
        return { action: "cancel-all", jobIds: taskRows.filter(item => getTaskState(item).busy).map(item => item.jobId) };
      }
      if (selected && result.relation !== "uncertain") return { action: "cancel", jobId: selected.jobId };
      const targets = taskRows.filter(item => !["completed", "cancelled", "failed", "awaiting_merge"].includes(item.status));
      if (!targets.length && getDialogue({ ...session, conversation_id: scope ?? session.conversation_id })?.step === "revert_confirm") {
        return { action: "cancel", topicId: scope ?? session.conversation_id };
      }
      if (!targets.length) return { action: "chat", reply: "当前范围内没有可取消的任务。" };
      if (targets.length === 1 && result.relation !== "uncertain") return { action: "cancel", jobId: targets[0].jobId };
      return { action: "chat", reply: "要取消哪项任务？你可以回复任务名称，或回复「全部」取消当前会话内所有正在处理或排队的任务。\n"
        + targets.slice(0, 12).map(item => `「${item.prompt.slice(0, 80)}」`).join("\n") };
    }
    if (result.intent === "help" || result.intent === "topics" || result.intent === "identity" || result.intent === "new") {
      return { action: result.intent };
    }
    if (result.intent === "execute" || result.intent === "merge" || result.intent === "discard" || result.intent === "refresh-tapd") {
      const commandName = { execute: "/执行", merge: "/合并", discard: "/放弃合并", "refresh-tapd": "/重新读取需求" }[result.intent];
      const target = sessionJobs.find(item => item.jobId === result.jobId);
      return { action: "chat", reply: `请发送「${commandName}${target ? ` ${target.jobId}` : ""}」。` };
    }
    if (command.topicId) result.topicId = command.topicId;
    else if (selection) result.topicId = contextSession.conversation_id;
    else if (result.relation === "new" && !["workflow", "revert", "clarify", "release"].includes(result.intent)) result.topicId = "new";
    if (!result.topicId || result.relation === "uncertain") {
      return { action: "chat", reply: result.reply.trim() || "你指的是哪个页面或需求？我确认后再继续。" };
    }
    if (result.intent === "release") {
      const topic = topics.find(item => item.id === result.topicId);
      if (!topic) return { action: "chat", reply: "你要合并哪次修改？请说明对应的页面或任务。" };
      const branch = result.targetBranch?.trim();
      if (!branch || !text.includes(branch) || !/^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/.test(branch)) return { action: "chat", reply: "你要合并到哪个分支？请提供完整分支名。" };
      const candidates = mergeCandidates.filter(item => item.topicId === topic.id && item.status === "completed" && item.mergedToDefaultBranch && item.commitSha);
      const source = result.jobId ? candidates.find(item => item.jobId === result.jobId) : candidates.length === 1 ? candidates[0] : undefined;
      if (!source) return { action: "chat", topicId: topic.id, historySource: "task", reply: candidates.length > 1
        ? `这个话题有多次修改，你要合并哪一次？\n${candidates.map(item => `${item.prompt.slice(0, 100)}\n任务编号：${item.jobId}`).join("\n\n")}`
        : "这个话题还没有可发版的已完成修改。请先完成代码修改和默认分支合并。" };
      return { action: "release", topicId: topic.id, jobId: source.jobId, targetBranch: branch };
    }
    if (result.intent === "revert") {
      const topic = topics.find(topic => topic.id === result.topicId);
      if (!topic) throw new Error("Unknown revert topic");
      if (selection) setDialogue(contextSession);
      return { action: "revert", topicId: topic.id };
    }
    if (result.intent === "workflow") {
      const topic = topics.find(topic => topic.id === result.topicId);
      if (!topic) throw new Error("Unknown workflow topic");
      const state = getDialogue({ ...session, conversation_id: topic.id });
      if (state?.step === "revert_confirm" || state?.step === "reverting") {
        return { action: "chat", topicId: topic.id, historySource: "task", reply: state.step === "reverting"
          ? "正在使用 Git revert 撤回，结果稍后通知你。"
          : "将使用 Git revert 撤回原修改。回复「/执行」确认撤回，或「/取消」保留原修改。" };
      }
      const current = topic.activeTask ? getJob(topic.activeTask.jobId) : undefined;
      if (!current || current.ownerId !== session.owner_id || !getBinding(current.jobId, session.session_key)) {
        return { action: "chat", topicId: topic.id, historySource: "task", reply: "这个话题目前没有待处理任务，可以直接告诉我新的需求。" };
      }
      return { action: "chat", topicId: topic.id, historySource: "task", reply: result.showDetails ? formatJob(current) : taskStatus(current) };
    }
    if (!result.prompt.trim()) throw new Error("Empty task prompt");
    const topic = result.topicId && result.topicId !== "new" ? topics.find(item => item.id === result.topicId) : undefined;
    if (result.topicId !== "new" && !topic) return { action: "chat", reply: "你指的是哪个页面或需求？请补充一下名称，我再继续。" };
    if (result.intent === "clarify" && topic?.activeTask?.status !== "awaiting_input") {
      return { action: "chat", reply: "这个话题没有等待补充的问题。你是想调整需求，还是询问当前实现？" };
    }
    if (selection) setDialogue(contextSession);
    return { action: result.intent, text: result.prompt.trim(),
      ...(command.projectId ? { projectId: command.projectId } : {}),
      ...(result.topicId ? { topicId: result.topicId, topicTitle: result.topicTitle ?? "" } : {}) };
  } catch (error) {
    const detail = error instanceof Error ? error.message || error.name : String(error);
    const reply = redactSensitiveText(detail.trim() || "意图识别失败，未返回错误详情。");
    console.warn("[WeCom] 意图识别失败：", reply);
    return { action: "chat", historySource: "task", routingFailed: true, reply };
  }
}
