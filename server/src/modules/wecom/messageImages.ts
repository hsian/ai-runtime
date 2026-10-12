import type { BaseMessage, ImageContent, WSClient } from "@wecom/aibot-node-sdk";
import { config } from "../../config.js";

export function extractMessageContent(body: BaseMessage): { text: string; images: ImageContent[] } {
  if (body.msgtype === "mixed") {
    if (!Array.isArray(body.mixed?.msg_item)) throw new Error("图文消息格式不完整，请重新发送。");
    const text: string[] = [];
    const images: ImageContent[] = [];
    for (const item of body.mixed.msg_item) {
      if (item.msgtype === "text" && typeof item.text?.content === "string") text.push(item.text.content);
      else if (item.msgtype === "image" && item.image) images.push(item.image);
      else throw new Error("图文消息包含无法读取的内容，请重新发送。");
    }
    return { text: text.join("\n"), images };
  }
  if (body.msgtype === "image") {
    if (!body.image) throw new Error("图片消息格式不完整，请重新发送。");
    return { text: "", images: [body.image] };
  }
  const content = (body.msgtype === "voice" ? body.voice : body.text)?.content;
  return { text: typeof content === "string" ? content : "", images: [] };
}

function imageFormat(buffer: Buffer): { mime: string; ext: string } | undefined {
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { mime: "image/png", ext: "png" };
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return { mime: "image/jpeg", ext: "jpg" };
  if (["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"))) return { mime: "image/gif", ext: "gif" };
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return { mime: "image/webp", ext: "webp" };
}

export async function downloadMessageImages(client: Pick<WSClient, "downloadFile">, images: ImageContent[]) {
  if (images.length > 9) throw new Error("单条消息最多支持 9 张图片，请分批发送。");
  const results: { name: string; mime: string; buffer: Buffer }[] = [];
  let total = 0;
  for (const [index, image] of images.entries()) {
    try {
      const url = new URL(image.url);
      if (url.protocol !== "https:" || url.username || url.password
        || !["qq.com", "weixin.qq.com", "wecom.cn"].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
        throw new Error("Invalid image URL");
      }
      const { buffer } = await client.downloadFile(image.url, image.aeskey);
      total += buffer.length;
      if (!buffer.length || buffer.length > config.UPLOAD_MAX_BYTES || total > 20 * 1024 * 1024) throw new Error("Image too large");
      const format = imageFormat(buffer);
      if (!format) throw new Error("Unsupported image format");
      results.push({ name: `wecom-image-${index + 1}.${format.ext}`, mime: format.mime, buffer });
    } catch {
      throw new Error(`第 ${index + 1} 张图片读取失败，请重新发送 JPEG、PNG、WebP 或 GIF 图片，并确保未超过上传大小限制。本次需求未执行。`);
    }
  }
  return results;
}
