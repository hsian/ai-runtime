import type { BaseMessage, ImageContent, WSClient } from "@wecom/aibot-node-sdk";
export const WECOM_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

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
    let stage = "address";
    let host = "";
    const fail = (reason: string) => new Error(`第 ${index + 1} 张图片读取失败：${reason} 本次消息未提交任务。`);
    try {
      const url = new URL(image.url);
      host = url.hostname;
      if (url.protocol !== "https:" || url.username || url.password
        || !["qq.com", "wecom.cn", "qpic.cn"].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
        throw new Error("Invalid image URL");
      }
      stage = "download";
      const { buffer } = await client.downloadFile(image.url, image.aeskey);
      stage = "size";
      total += buffer.length;
      if (!buffer.length) throw fail("下载结果为空，请重新发送图片。");
      if (buffer.length > WECOM_IMAGE_MAX_BYTES) throw fail("单张图片不能超过 10MB，请缩小后重新发送。");
      if (total > 20 * 1024 * 1024) throw fail("本条消息的图片总大小不能超过 20MB，请分批发送。");
      stage = "format";
      const format = imageFormat(buffer);
      if (!format) throw fail("下载内容无法识别为 JPEG、PNG、WebP 或 GIF 图片，请重新发送。");
      results.push({ name: `wecom-image-${index + 1}.${format.ext}`, mime: format.mime, buffer });
    } catch (error) {
      const metadata = error as { code?: unknown; response?: { status?: unknown } } | undefined;
      // Never log signed URLs, keys, response bodies or raw SDK errors.
      console.warn("[WeCom] 图片读取失败", { index: index + 1, stage, host,
        code: typeof metadata?.code === "string" && /^[A-Z0-9_]{1,40}$/.test(metadata.code) ? metadata.code : undefined,
        httpStatus: typeof metadata?.response?.status === "number" ? metadata.response.status : undefined });
      if (stage === "size" || stage === "format") throw error;
      throw fail(stage === "address" ? "图片下载地址未通过校验，请联系管理员检查服务日志。"
        : "服务器下载或解密企微图片失败，请重新发送；若仍失败，请联系管理员检查服务日志。");
    }
  }
  return results;
}
