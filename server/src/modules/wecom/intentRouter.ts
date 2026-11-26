import { getJob } from "../../services/jobStore.js";
import { getBinding, getChatHistory, getConversationHistory, listBindings } from "./sessionStore.js";
import type { WecomSession } from "./types.js";
import type { Command } from "./commands.js";
import type { Job } from "../../types.js";
import { topicCandidates } from "./topicStore.js";
import { getDialogue, setDialogue } from "./dialogueStore.js";
import { formatJob } from "./replies.js";
import { classifyWithAgent, routeConversation, type IntentModel } from "../../services/conversationIntent.js";
export { classifyWithAgent, type IntentModel } from "../../services/conversationIntent.js";
import { chatQuickReply } from "../../services/chatQuickReply.js";

export function quickReply(text: string): Command | undefined {
  const reply = chatQuickReply(text);
  return reply ? { action: "chat", reply } : undefined;
}

export async function resolveIntent(command: Command, session: WecomSession, model: IntentModel = classifyWithAgent): Promise<Command> {
  if (command.action !== "auto") return command;
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
  const quick = quickReply(text);
  if (quick) return quick;
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
    const payload = { message: text, mergeCandidates,
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
    if (result.intent === "chat" || result.intent === "uncertain") {
      if (!result.reply.trim()) throw new Error("Empty reply");
      return { action: "chat", reply: result.reply.trim() };
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
          : "将使用 Git revert 撤回原修改。回复「执行」确认撤回，或「取消」保留原修改。" };
      }
      const current = topic.activeTask ? getJob(topic.activeTask.jobId) : undefined;
      if (!current || current.ownerId !== session.owner_id || !getBinding(current.jobId, session.session_key)) {
        return { action: "chat", topicId: topic.id, historySource: "task", reply: "这个话题目前没有待处理任务，可以直接告诉我新的需求。" };
      }
      return { action: "chat", topicId: topic.id, historySource: "task", reply: `以下是已有任务的状态，不是本次新生成的方案：\n${formatJob(current)}` };
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
    console.warn("[WeCom] 意图识别失败：", error instanceof Error ? error.message : "Unknown error");
    return { action: "chat", historySource: "task", reply: "抱歉，这次消息处理失败了，不是你表达的问题。请稍后重试，刚才关联的需求资料仍然保留。" };
  }
}
