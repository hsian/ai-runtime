import { getJob } from "../../services/jobStore.js";
import { runAgent } from "../../services/agent/index.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBinding, getChatHistory, getConversationHistory } from "./sessionStore.js";
import type { WecomSession } from "./types.js";
import type { Command } from "./commands.js";
import { topicCandidates } from "./topicStore.js";
import { getDialogue, setDialogue } from "./dialogueStore.js";
import { formatJob } from "./replies.js";
import { parseRoutingResult, routingAgentOptions, type RoutingStage } from "./conversationRouting.js";

export function quickReply(text: string): Command | undefined {
  const content = text.trim();
  const normalized = content.replace(/[\s!！?？。.,，~～]/g, "");
  if (/^(你好|您好|嗨|哈喽|hi|hello|hey|在吗|在不在|早上好|晚上好|下午好)$/i.test(normalized)) {
    return { action: "chat", reply: "你好，我在。你可以和我聊聊，也可以直接问项目问题或告诉我想改什么。" };
  }
  if (/^(谢谢|谢谢你|多谢|感谢|辛苦了|thanks|thankyou)$/i.test(normalized)) {
    return { action: "chat", reply: "不客气，有问题随时说。" };
  }
  if (/^(你是谁|你能做什么|你会做什么|你有什么功能)$/.test(normalized)) {
    return { action: "chat", reply: "我是项目开发助手，可以解释代码、排查问题、生成测试用例 Excel，也可以修改功能。修改前会先给你计划，等你确认执行。" };
  }
  if (/^(test|测试)$/i.test(normalized)) return { action: "chat", reply: "消息收到了，连接正常。" };
  return undefined;
}

export type IntentModel = (input: string, stage?: RoutingStage) => Promise<string>;

export async function classifyWithAgent(input: string, stage: RoutingStage = "request"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ai-runtime-wecom-intent-"));
  try {
    const result = await runAgent(directory, input, undefined, undefined, routingAgentOptions(stage));
    return result.summary;
  } finally {
    // Windows may hold the CLI's working directory until its process exits.
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
      .catch(() => console.warn("[WeCom] 临时会话目录暂时被占用，未影响识别结果"));
  }
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
    const request = parseRoutingResult(await model(JSON.stringify({ message: text,
      history: getConversationHistory(contextSession),
      lastQuestion: active?.clarificationQuestions ?? (selection ? dialogue?.question : undefined),
      linkedReference: Boolean(command.topicId) }), "request"));
    if (request.intent === "chat" || request.intent === "uncertain") {
      if (!request.reply.trim()) throw new Error("Empty reply");
      return { action: "chat", reply: request.reply.trim() };
    }
    if (!["workflow", "revert"].includes(request.intent) && !request.prompt.trim()) throw new Error("Empty task prompt");
    const needsContext = Boolean(command.topicId || selection) || request.relation !== "new"
      || ["workflow", "revert", "clarify"].includes(request.intent);
    let result: ReturnType<typeof parseRoutingResult> = { ...request, topicId: "new" };
    if (needsContext) {
      result = parseRoutingResult(await model(JSON.stringify({ message: text, request,
        topics: topics.map(topic => ({ id: topic.id, title: topic.title, current: topic.current,
          tapd: topic.tapd,
          questions: topic.activeTask?.questions,
          history: getChatHistory({ ...session, conversation_id: topic.id }).filter(turn => turn.role === "user").slice(-4),
          userGoal: topic.activeTask?.prompt })),
        linkedTopicId: command.topicId, selectionTopicId: selection ? contextSession.conversation_id : undefined }), "context"));
      if (result.intent !== request.intent) throw new Error("Context selection changed request intent");
      if (!result.topicId) {
        return { action: "chat", reply: result.reply.trim() || "你指的是哪个页面或需求？我确认后再继续。" };
      }
    }
    if (selection && result.topicId && result.topicId !== contextSession.conversation_id) {
      return { action: "chat", reply: "这个选项属于当前话题，请确认你要继续哪个话题的方案。" };
    }
    if (command.topicId) result.topicId = command.topicId;
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
    if (result.intent === "chat" || result.intent === "uncertain") throw new Error("Unexpected task intent");
    if (!result.prompt.trim()) throw new Error("Empty task prompt");
    const topic = result.topicId && result.topicId !== "new" ? topics.find(item => item.id === result.topicId) : undefined;
    if (result.topicId && result.topicId !== "new" && !topic) throw new Error("Unknown topic");
    if (result.intent === "clarify" && (topic?.activeTask ?? (!result.topicId ? active : undefined))?.status !== "awaiting_input") {
      throw new Error("Unexpected clarification");
    }
    if (selection) setDialogue(contextSession);
    return { action: result.intent, text: result.prompt.trim(),
      ...(command.agentProvider ? { agentProvider: command.agentProvider } : {}),
      ...(command.projectId ? { projectId: command.projectId } : {}),
      ...(result.topicId ? { topicId: result.topicId, topicTitle: result.topicTitle ?? "" } : {}) };
  } catch (error) {
    console.warn("[WeCom] 意图识别失败：", error instanceof Error ? error.message : "Unknown error");
    return { action: "chat", reply: "抱歉，这次消息处理失败了，不是你表达的问题。请稍后重试，刚才关联的需求资料仍然保留。" };
  }
}
