import type { WSClient } from "@wecom/aibot-node-sdk";
import type { MessageFrame } from "./client.js";
import { reply } from "./client.js";
import type { WecomConfig } from "./config.js";
import { getSession, hasMessage, rememberMessage, recordChatExchange } from "./sessionStore.js";
import { parseCommand } from "./commands.js";
import { dispatchCommand } from "./jobBridge.js";
import { resolveIntent, quickReply } from "./intentRouter.js";
import { randomUUID } from "node:crypto";
import { THINKING } from "./replies.js";
import { prepareTapdMessage, extractTapdLink } from "./tapdBridge.js";
import type { ResponseCoordinator } from "./responseCoordinator.js";

export function createMessageHandler(client: WSClient, options: WecomConfig, routeIntent = resolveIntent, prepareMessage = prepareTapdMessage,
  responses?: ResponseCoordinator) {
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
        const release = responses?.block(target);
        let trackedJob: string | undefined;
        let text: string;
        try {
          if (body.msgtype !== "text") {
            rememberMessage(messageKey);
            text = "目前支持文字消息，请用文字描述修改需求。";
          } else {
            const content = (body.text as { content?: unknown } | undefined)?.content;
            if (typeof content !== "string" || !content.trim()) throw new Error("请发送文字需求。");
            if (content.length > 50_000) throw new Error("消息不能超过 50000 字符。");
            const session = getSession(options.botId, target, body.from.userid, options.projectId);
            const parsed = parseCommand(content);
            if ((parsed.action === "auto" && !quickReply(parsed.text)) || extractTapdLink(content)) {
              try { await client.replyStream(frame, streamId, THINKING, false); }
              catch { console.warn("[WeCom] 初始回复发送失败"); }
            }
            const prepared = await prepareMessage(session, content);
            if (stopped) return;
            const resolved = await routeIntent(prepared.command, session);
            const command = prepared.topicId ? { ...resolved, topicId: prepared.topicId } : resolved;
            if (stopped) return;
            text = await dispatchCommand(session, command, messageKey, options, responses ? jobId => {
              trackedJob = jobId;
              responses.track(jobId, frame, streamId, target);
            } : undefined);
            if (command.action === "cancel") {
              const cancelledId = command.jobId ?? session.active_job_id;
              if (cancelledId) await responses?.finish(cancelledId, "任务已取消。");
            }
            if (prepared.prefix) text = `${prepared.prefix}\n\n${text}`;
            recordChatExchange(getSession(options.botId, target, body.from.userid, options.projectId), content, trackedJob ? undefined : text);
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
        }
        try {
          if (trackedJob) await client.replyStream(frame, streamId, THINKING, false);
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
