import { randomInt, randomUUID } from "node:crypto";
import type { EventMessage, TemplateCard, WSClient, WsFrame } from "@wecom/aibot-node-sdk";
import { getProject } from "../../services/projectRegistry.js";
import { deleteJobAttachments, saveImageBuffers } from "../../services/uploadService.js";
import { logOperation } from "../../services/operationLog.js";
import { reply, type MessageFrame } from "./client.js";
import { parseTaskPrefixes } from "./commands.js";
import type { WecomConfig } from "./config.js";
import { createConversationActions, parseConfirmationButton, readConfirmationClick } from "./conversationActions.js";
import { ProjectReadPreparationError, runDirectConversation } from "./directConversation.js";
import { downloadMessageImages, extractMessageContent, WECOM_IMAGE_MAX_BYTES } from "./messageImages.js";
import type { ResponseCoordinator } from "./responseCoordinator.js";
import { getSession, hasMessage, recordChatExchange, rememberMessage } from "./sessionStore.js";
import { extractTapdLink, prepareTapdMessage } from "./tapdBridge.js";

const progressReplies = ["我看看。", "稍等一下。", "别急，正在处理。", "莫慌，我看下。"];
const CARD_STREAM_WINDOW_MS = 270_000;

interface ConfirmationStream {
  frame: MessageFrame;
  started: number;
  sessionKey: string;
  ready: Promise<void>;
  timer: ReturnType<typeof setTimeout>;
}

export function createDirectMessageHandler(client: WSClient, options: WecomConfig, responses?: ResponseCoordinator,
  converse = runDirectConversation, actions = createConversationActions(options), prepareTapd = prepareTapdMessage) {
  const chains = new Map<string, Promise<void>>();
  const cardStreams = new Map<string, ConfirmationStream>();
  let stopped = false;

  const takeCardStream = (cardId: string) => {
    const stream = cardStreams.get(cardId);
    if (!stream) return;
    clearTimeout(stream.timer);
    cardStreams.delete(cardId);
    return stream;
  };
  return {
    stop() {
      stopped = true;
      actions.clear();
      for (const id of cardStreams.keys()) takeCardStream(id);
    },
    handleConfirmation(frame: WsFrame<EventMessage>): void {
      if (stopped || !frame.body) return;
      console.info("[WeCom] 收到确认卡点击回调");
      logOperation({ action: "wecom_confirmation", status: "started" });
      let text: string | undefined;
      let started: { jobId: string; target: string } | undefined;
      try {
        text = actions.confirm(frame.body, reason => {
          console.info(`[WeCom] 未处理确认卡：${reason}`);
          logOperation({ action: "wecom_confirmation", status: "cancelled", message: reason });
        }, (jobId, target) => { started = { jobId, target }; });
      }
      catch (error) {
        logOperation({ action: "wecom_confirmation", status: "failed", error: String(error) });
        text = "确认操作未完成，请查看任务状态后再试。";
      }
      const click = readConfirmationClick(frame.body);
      const button = parseConfirmationButton(click?.eventKey);
      const origin = text && started && responses && button ? takeCardStream(button.id) : undefined;
      if (text && started && responses && origin) {
        responses.start(started.jobId, origin.frame, randomUUID(), started.target, origin.started, text, origin.ready);
        return;
      }
      if (text && frame.body.event.eventtype === "template_card_event") {
        if (button) takeCardStream(button.id);
        const event = frame.body;
        const target = event.chattype === "single" ? event.from.userid : event.chatid ?? event.from.userid;
        const cardId = click?.taskId || button?.id;
        void client.updateTemplateCard(frame, { card_type: "text_notice", task_id: cardId,
          main_title: { title: "任务确认", desc: text.slice(0, 30) }, sub_title_text: text })
          .catch(async error => {
            logOperation({ action: "wecom_confirmation_card_update", status: "failed", error: String(error) });
            if (target) await client.sendMessage(target, { msgtype: "markdown", markdown: { content: text } });
          }).catch(() => console.warn("[WeCom] 确认回复发送失败"));
      }
    },
    handle(frame: MessageFrame): void {
      const body = frame.body;
      if (stopped || !body || (body.msgtype as string) === "event"
        || body.aibotid !== options.botId || !body.msgid || !body.from?.userid) return;
      const sender = body.from.userid;
      const target = body.chattype === "group" ? body.chatid : sender;
      if (!target) return;
      const key = JSON.stringify([target, sender]);
      const messageKey = JSON.stringify([options.botId, body.msgid]);
      const next = (chains.get(key) ?? Promise.resolve()).then(async () => {
        if (stopped || hasMessage(messageKey)) return;
        rememberMessage(messageKey);
        const streamId = randomUUID();
        const release = responses?.block(target);
        const started = Date.now();
        let progress = Promise.resolve();
        const progressTimer = setTimeout(() => {
          if (!stopped) {
            const text = progressReplies[randomInt(progressReplies.length)];
            progress = client.replyStream(frame, streamId, text, false).then(() => undefined, () => undefined);
          }
        }, 1500);
        const send = async (text: string, card?: TemplateCard) => {
          clearTimeout(progressTimer);
          await progress;
          if (!stopped) await reply(client, frame, text, streamId, card);
        };
        let imageDirectory: string | undefined;
        let failure = "这次没能完成回复，请稍后再试。";
        try {
          if (!["text", "voice", "image", "mixed"].includes(body.msgtype)) {
            await send("目前可以接收文字、语音和图片。");
            return;
          }
          const extracted = extractMessageContent(body);
          const input = parseTaskPrefixes(extracted.text);
          const message = input.text || (extracted.images.length ? "请看看我发的图片。" : "");
          if (!message) {
            await send(body.msgtype === "voice" ? "这条语音没能转成文字，请重发一下。" : "这条消息没有内容。");
            return;
          }
          if (message.length > 50_000) {
            await send("这条消息太长了，请分开发。");
            return;
          }
          const projectId = getProject(input.projectId ?? options.projectId).id;
          const session = getSession(options.botId, target, sender, projectId);
          if (extractTapdLink(message)) {
            failure = "这次没读到 TAPD 资料，请检查链接后再试。";
            await prepareTapd(session, message);
          }
          failure = "这次没能读取你发的图片，请重发一下。";
          const images = await downloadMessageImages(client, extracted.images);
          imageDirectory = images.length ? randomUUID() : undefined;
          const attachments = imageDirectory ? saveImageBuffers(imageDirectory, images, WECOM_IMAGE_MAX_BYTES) : [];
          if (stopped) return;
          failure = "这次没能完成回复，请稍后再试。";
          const agentStarted = Date.now();
          const result = await converse(session, projectId, message, attachments);
          logOperation({ action: "wecom_conversation_agent", status: "success", durationMs: Date.now() - agentStarted });
          if (stopped) return;
          const action = result.proposal ? actions.offer(session, projectId, result.proposal) : undefined;
          const text = [result.text, action?.text].filter(Boolean).join("\n\n");
          recordChatExchange(session, message, result.text, "conversation", false);
          const cardId = action?.card?.task_id;
          const ready = send(text, action?.card);
          if (cardId) {
            for (const [id, origin] of cardStreams) {
              if (origin.sessionKey === session.session_key) takeCardStream(id);
            }
            const timer = setTimeout(() => takeCardStream(cardId), Math.max(0, started + CARD_STREAM_WINDOW_MS - Date.now()));
            timer.unref();
            cardStreams.set(cardId, { frame, started, sessionKey: session.session_key, ready, timer });
          }
          try { await ready; }
          catch (error) {
            if (!cardId) throw error;
            takeCardStream(cardId);
            actions.discard(cardId);
            logOperation({ action: "wecom_confirmation_card", status: "failed", error: String(error) });
            await send(`${text}\n\n确认卡没有发送成功，操作没有开始。请稍后再试。`);
          }
          logOperation({ action: "wecom_conversation", status: "success", durationMs: Date.now() - started });
        } catch (error) {
          logOperation({ action: "wecom_conversation", status: "failed", error: String(error), durationMs: Date.now() - started });
          if (!stopped) await send(error instanceof ProjectReadPreparationError ? error.message : failure).catch(() => undefined);
        } finally {
          clearTimeout(progressTimer);
          if (imageDirectory) await deleteJobAttachments(imageDirectory).catch(() => console.warn("[WeCom] 临时图片清理失败"));
          release?.();
        }
      }).catch(() => console.warn("[WeCom] 消息处理失败"));
      chains.set(key, next);
      void next.finally(() => { if (chains.get(key) === next) chains.delete(key); });
    },
  };
}
