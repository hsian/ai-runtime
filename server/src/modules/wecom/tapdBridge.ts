import { randomUUID } from "node:crypto";
import { load } from "cheerio";
import { config, getTapdConfig } from "../../config.js";
import { resolveTapdContext } from "../../services/tapd/resolveContext.js";
import { parseTapdUrl } from "../../services/tapd/tapdClient.js";
import { downloadImagesFromHtml, extractImageUrlsFromHtml, isTrustedTapdImageUrl } from "../../services/tapd/tapdDescriptionImages.js";
import { normalizeTapdEditableContent } from "../../services/tapd/tapdEditableContext.js";
import { saveImageBuffers, deleteJobAttachments } from "../../services/uploadService.js";
import { findTapdTopic, getTopicTapd, saveTopicTapd, type TapdSnapshot } from "./tapdStore.js";
import { selectTopic } from "./topicStore.js";
import { parseCommand, type Command } from "./commands.js";
import type { WecomSession } from "./types.js";
import { getDatabase } from "../../services/database.js";

export type TapdLoader = (url: string) => Promise<TapdSnapshot>;
const snapshotDependencies = { getConfig: getTapdConfig, resolve: resolveTapdContext, download: downloadImagesFromHtml };

export function extractTapdLink(text: string): { url: string; request: string } | undefined {
  const matches = [...text.matchAll(/https?:\/\/[^\s<>"']+/gi)].map(match => {
    const url = match[0].replace(/[，。；！、）)\]}]+$/, "");
    try {
      const parsed = new URL(url);
      if (!["tapd.cn", "tapd.com"].some(domain => parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`))) return undefined;
      if (parsed.username || parsed.password || (parsed.port && !["80", "443"].includes(parsed.port))) throw new Error("TAPD 链接格式不正确。");
      return { url, index: match.index! };
    } catch (error) {
      if (error instanceof Error && error.message === "TAPD 链接格式不正确。") throw error;
      return undefined;
    }
  }).filter((match): match is { url: string; index: number } => Boolean(match));
  if (matches.length > 1) throw new Error("请一次发送一个 TAPD 条目，避免混用需求资料。");
  const match = matches[0];
  if (!match) return undefined;
  const parsed = parseTapdUrl(match.url);
  if (!parsed.workspaceId || !parsed.itemType || !parsed.itemId) throw new Error("请发送 TAPD 需求、任务或 Bug 的详情链接，列表或迭代链接暂不支持。");
  const request = `${text.slice(0, match.index)} ${text.slice(match.index + match.url.length)}`
    .trim().replace(/^[\s:：,，。;；)）]+|[\s:：,，。;；)）]+$/g, "").replace(/^TAPD\s*[:：]?\s*$/i, "");
  return { url: match.url, request };
}

export async function loadTapdSnapshot(url: string, dependencies = snapshotDependencies): Promise<TapdSnapshot> {
  const cfg = dependencies.getConfig();
  const parsed = parseTapdUrl(url);
  if (!cfg.workspaces.some(workspace => workspace.id === parsed.workspaceId)) {
    throw new Error("此 TAPD 项目不在已配置的可读取范围内，请联系管理员配置。");
  }
  const resolved = await dependencies.resolve(url);
  const $ = load(resolved.sourceHtml, undefined, false);
  const images: { name: string; mime: string; buffer: Buffer }[] = [];
  const warnings: string[] = resolved.commentWarning ? [resolved.commentWarning] : [];
  const started = Date.now();
  let totalBytes = 0;
  for (const [index, element] of $("img").toArray().entries()) {
    const html = $.html(element);
    const imageUrl = extractImageUrlsFromHtml(html)[0];
    let retained = false;
    if (index < 20 && Date.now() - started < 90_000 && imageUrl && isTrustedTapdImageUrl(imageUrl)) {
      try {
        const report = await dependencies.download(html, resolved.workspaceId, cfg, true);
        const image = report.images[0];
        if (image && /^image\/(jpeg|jpg|png|webp|gif)$/i.test(image.mime)) {
          const buffer = Buffer.from(image.dataUrl.slice(image.dataUrl.indexOf(",") + 1), "base64");
          if (buffer.length && buffer.length <= config.UPLOAD_MAX_BYTES && totalBytes + buffer.length <= 20 * 1024 * 1024) {
            totalBytes += buffer.length;
            images.push({ name: `tapd-description-${images.length + 1}.${image.name.split(".").at(-1)}`, mime: image.mime, buffer });
            retained = true;
          }
        }
      } catch { /* Keep the readable body when an individual image is unavailable. */ }
    }
    if (!retained) $(element).replaceWith(`<span>[原配图${index + 1}未读取]</span>`);
  }
  const normalized = normalizeTapdEditableContent($.html());
  const { sourceHtml: _sourceHtml, ...context } = resolved;
  context.description = normalized.description.slice(0, 30_000);
  context.attachedImageCount = images.length;
  context.attachedImageIndexes = images.map((_image, index) => index + 1);
  if (images.length < (context.imageCount ?? 0)) warnings.push(`配图仅成功读取 ${images.length}/${context.imageCount} 张；缺失位置已标注，不会猜测图片内容。`);
  if (normalized.description.length > 30_000) warnings.push("资料较长，本次正文已截断到 30000 字符。");
  context.readWarnings = warnings;
  const snapshotId = randomUUID();
  try { return { snapshotId, context, attachments: saveImageBuffers(snapshotId, images), warnings }; }
  catch (error) { await deleteJobAttachments(snapshotId); throw error; }
}

export function formatTapdSnapshot(snapshot: TapdSnapshot): string {
  const context = snapshot.context;
  const label = context.itemType === "bug" ? "Bug" : context.itemType === "task" ? "任务" : "需求";
  return `已读取 TAPD ${label}：${context.title}\n条目：${context.itemId}\n`
    + `评论：${context.commentCount} 条 · 配图：${context.attachedImageCount ?? 0}/${context.imageCount ?? 0} 张\n\n`
    + `资料节选：\n${context.description.slice(0, 600).split("\n").map(line => `> ${line}`).join("\n")}`
    + (context.description.length > 600 ? "\n（任务会读取保存的完整正文，而非只读取以上节选）" : "")
    + (snapshot.warnings.length ? `\n\n读取提醒：\n${snapshot.warnings.join("\n")}` : "");
}

export interface PreparedTapdMessage { command: Command; prefix?: string; topicId?: string }

export async function prepareTapdMessage(session: WecomSession, text: string, loader: TapdLoader = loadTapdSnapshot): Promise<PreparedTapdMessage> {
  const link = extractTapdLink(text);
  const refresh = /^(重新读取需求|重新读取|刷新需求)$/.test(text.trim());
  if (!link && !refresh) return { command: parseCommand(text) };
  const previous = getTopicTapd(session);
  if (refresh && !previous) throw new Error("当前话题还没有关联 TAPD 条目，请先发送详情链接。");
  const url = link?.url ?? previous!.context.url;
  const parsed = parseTapdUrl(url);
  let snapshot: TapdSnapshot;
  try { snapshot = await loader(url); }
  catch (error) { throw new Error(`TAPD 读取失败，本次未启动任务：${error instanceof Error ? error.message.slice(0, 300) : "请稍后重试"}`); }
  const existing = findTapdTopic(session, parsed.workspaceId!, parsed.itemType!, parsed.itemId!);
  let old: TapdSnapshot | undefined;
  const original = { conversation_id: session.conversation_id, active_job_id: session.active_job_id };
  try {
    getDatabase().transaction(() => {
      selectTopic(session, existing ?? "new", snapshot.context.title);
      old = getTopicTapd(session);
      saveTopicTapd(session, snapshot);
    })();
  } catch (error) {
    Object.assign(session, original);
    await deleteJobAttachments(snapshot.snapshotId);
    throw error;
  }
  if (old && old.snapshotId !== snapshot.snapshotId) {
    await deleteJobAttachments(old.snapshotId).catch(() => console.warn("[WeCom] 旧 TAPD 配图清理失败"));
  }
  const summary = formatTapdSnapshot(snapshot);
  if (!link?.request || refresh) return { command: { action: "chat", topicId: session.conversation_id,
    reply: `${summary}\n\n${refresh ? "资料已更新，已启动的任务仍使用原快照。" : "你想先分析这个条目，还是按它实现？"}` } };
  const requested = parseCommand(link.request);
  const command: Command = ["auto", "question", "plan", "clarify"].includes(requested.action)
    ? requested : { action: "auto", text: link.request };
  return { command: { ...command, topicId: session.conversation_id }, prefix: summary, topicId: session.conversation_id };
}
