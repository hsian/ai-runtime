import type { WSClient } from "@wecom/aibot-node-sdk";
import type { MessageFrame } from "./client.js";
import { reply } from "./client.js";
import type { WecomConfig } from "./config.js";
import { getSession, getBinding, hasMessage, rememberMessage, recordChatExchange } from "./sessionStore.js";
import { getJob } from "../../services/jobStore.js";
import { getProject } from "../../services/projectRegistry.js";
import { parseCommand, parseTaskPrefixes, requiresTextConfirmation } from "./commands.js";
import { dispatchCommand } from "./jobBridge.js";
import { resolveIntent, quickReply } from "./intentRouter.js";
import { randomUUID } from "node:crypto";
import { THINKING, withEngineFooter } from "./replies.js";
import { prepareTapdMessage, extractTapdLink } from "./tapdBridge.js";
import type { ResponseCoordinator } from "./responseCoordinator.js";
import { extractMessageContent, downloadMessageImages, WECOM_IMAGE_MAX_BYTES } from "./messageImages.js";
import { saveImageBuffers, deleteJobAttachments } from "../../services/uploadService.js";
import type { createWorkbenchBridge } from "./workbenchBridge.js";

const VOICE_CONFIRMATION_REQUIRED = "为避免语音识别误操作，执行、取消、撤回和合并等操作请用文字发送。语音可以用于问答和描述修改需求。";

export function createMessageHandler(client: WSClient, options: WecomConfig, routeIntent = resolveIntent, prepareMessage = prepareTapdMessage,
  responses?: ResponseCoordinator, dispatch = dispatchCommand, workbench?: ReturnType<typeof createWorkbenchBridge>) {
  const chains = new Map<string, Promise<void>>();
  let stopped = false;
  return {
    stop() { stopped = true; },
    handle(frame: MessageFrame): void {
      const body = frame.body;
      if (stopped || !body || body.aibotid !== options.botId || !body.msgid || !body.from?.userid) return;
      const target = body.chattype === "group" ? body.chatid : body.from.userid;
      if (!target) return;
      const key = JSON.stringify([options.botId, target, body.from.userid, options.projectId]);
      const messageKey = JSON.stringify([options.botId, body.msgid]);
      const previous = chains.get(key) ?? Promise.resolve();
      const next = previous.then(async () => {
        if (stopped || hasMessage(messageKey)) return;
        const streamId = randomUUID();
        const responseStarted = Date.now();
        const release = responses?.block(target);
        let trackedJob: string | undefined;
        let imageDirectory: string | undefined;
        let text: string;
        try {
          const voice = body.msgtype === "voice";
          if (!["text", "voice", "image", "mixed"].includes(body.msgtype)) {
            rememberMessage(messageKey);
            text = "目前支持文字、语音、图片和图文消息，暂不支持这种消息类型。";
          } else {
            const extracted = extractMessageContent(body);
            let content = extracted.text;
            if (extracted.images.length && !parseTaskPrefixes(content).text) {
              content = `${content.trim()} 问答：请分析本条消息附带的图片；如没有明确操作要求，只解释图片或询问需要处理什么，不修改代码。`.trim();
            }
            if (!content.trim()) throw new Error(voice
              ? "这条语音没有可用的转写文本，请重发或改用文字。" : "请发送文字需求。");
            if (content.length > 50_000) throw new Error("消息不能超过 50000 字符。");
            const workbenchReply = await workbench?.reply(body.from.userid, content, {
              group: body.chattype === "group", voice, images: extracted.images.length > 0,
            });
            if (workbenchReply !== undefined) {
              rememberMessage(messageKey);
              text = workbenchReply;
            } else {
            const parsed = parseCommand(content);
            let projectId = getProject(parsed.projectId ?? options.projectId).id;
            if ("jobId" in parsed && parsed.jobId && !parsed.projectId) {
              const job = getJob(parsed.jobId);
              if (job?.ownerId === `wecom:${options.botId}:${body.from.userid}`) {
                const jobSession = getSession(options.botId, target, body.from.userid, job.projectId);
                if (getBinding(job.jobId, jobSession.session_key)) projectId = job.projectId;
              }
            }
            const taskOptions = { ...options, projectId };
            const session = getSession(options.botId, target, body.from.userid, projectId);
            // Transcription may append punctuation; never let it turn a spoken confirmation into an action.
            const voiceCommand = voice ? parseCommand(content.trim().replace(/[。.!！?？]+$/, "").trim()) : parsed;
            if (voice && requiresTextConfirmation(voiceCommand)) {
              throw new Error(VOICE_CONFIRMATION_REQUIRED);
            }
            if ((parsed.action === "auto" && !quickReply(parsed.text)) || extractTapdLink(content)) {
              try { await client.replyStream(frame, streamId, THINKING, false); }
              catch { console.warn("[WeCom] 初始回复发送失败"); }
            }
            const prepared = await prepareMessage(session, content);
            if (stopped) return;
            const imageBuffers = await downloadMessageImages(client, extracted.images);
            let resolved = await routeIntent(prepared.command, session);
            // A text-only classifier cannot answer an image question itself.
            if (imageBuffers.length && resolved.action === "chat") {
              const prefixes = parseTaskPrefixes(content);
              resolved = { action: "question", text: prefixes.text,
                projectId: prefixes.projectId, topicId: resolved.topicId, topicTitle: resolved.topicTitle };
            }
            const command = prepared.topicId ? { ...resolved, topicId: prepared.topicId } : resolved;
            if (stopped) return;
            if (voice && requiresTextConfirmation(command)) {
              throw new Error(VOICE_CONFIRMATION_REQUIRED);
            }
            if (imageBuffers.length && !["plan", "question", "test-case", "clarify"].includes(command.action)) {
              throw new Error("图片需与问题或修改说明一起发送；执行、取消等操作请单独发送文字命令。");
            }
            imageDirectory = imageBuffers.length ? randomUUID() : undefined;
            const attachments = imageDirectory ? saveImageBuffers(imageDirectory, imageBuffers, WECOM_IMAGE_MAX_BYTES) : [];
            text = await dispatch(session, command, messageKey, taskOptions, responses ? jobId => {
              trackedJob = jobId;
              responses.track(jobId, frame, streamId, target, responseStarted);
            } : undefined, attachments);
            if (command.action === "cancel") {
              const cancelledId = command.jobId ?? session.active_job_id;
              if (cancelledId) await responses?.finish(cancelledId, "任务已取消。");
            }
            if (prepared.prefix) text = `${prepared.prefix}\n\n${text}`;
            recordChatExchange(getSession(options.botId, target, body.from.userid, projectId), content, trackedJob ? undefined : text,
              command.action === "chat" && !command.historySource && !prepared.prefix ? "conversation" : "task");
            }
          }
        } catch (error) {
          rememberMessage(messageKey);
          text = error instanceof Error ? error.message : "消息处理失败，请回复「状态」查询任务。";
          if (trackedJob) {
            try { await responses?.finish(trackedJob, text); }
            catch { console.warn("[WeCom] 错误回复发送失败"); }
            release?.();
            return;
          }
        } finally {
          if (imageDirectory) await deleteJobAttachments(imageDirectory).catch(() => console.warn("[WeCom] 临时图片清理失败"));
        }
        try {
          if (trackedJob) await client.replyStream(frame, streamId, withEngineFooter(getJob(trackedJob), THINKING), false);
          else await reply(client, frame, text, streamId);
        }
        catch { console.warn("[WeCom] 即时回复发送失败，任务结果会异步通知"); }
        finally { release?.(); }
      }).catch(() => console.error("[WeCom] 消息处理失败"));
      chains.set(key, next);
      void next.finally(() => { if (chains.get(key) === next) chains.delete(key); });
    },
  };
}
