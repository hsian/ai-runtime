import { WSClient, type WsFrame, type BaseMessage, type TemplateCard } from "@wecom/aibot-node-sdk";
import { randomUUID } from "node:crypto";
import { logOperation } from "../../services/operationLog.js";
import type { WecomConfig } from "./config.js";
import { splitMessage } from "./replies.js";

export type MessageFrame = WsFrame<BaseMessage>;

export function createWecomClient(options: WecomConfig): WSClient {
  return new WSClient({ botId: options.botId, secret: options.secret, maxReconnectAttempts: -1,
    // Avoid logging protocol payloads, which can contain credentials and code.
    logger: {
      debug: () => {}, info: () => {}, warn: () => console.warn("[WeCom] 连接或发送警告"),
      error: () => console.error("[WeCom] 连接或发送错误"),
    } });
}

export async function reply(client: WSClient, frame: MessageFrame, text: string, streamId: string = randomUUID(), card?: TemplateCard): Promise<void> {
  const chunks = splitMessage(text);
  const target = frame.body?.chattype === "group" ? frame.body.chatid : frame.body?.from.userid;
  const first = chunks[0] ?? "";
  await client.replyStream(frame, streamId, first, !card);
  if (target) for (const chunk of chunks.slice(1)) {
    await client.sendMessage(target, { msgtype: "markdown", markdown: { content: chunk } });
  }
  if (card) {
    await client.replyTemplateCard(frame, card);
    logOperation({ action: "wecom_confirmation_card", status: "success" });
    await client.replyStream(frame, streamId, first, true).catch(error => {
      logOperation({ action: "wecom_confirmation_stream_end", status: "failed", error: String(error) });
    });
  }
}
