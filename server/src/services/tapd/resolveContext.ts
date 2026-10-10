import type { TapdContext } from "../../types.js";
import { getStory, getTask, getBug, listTapdComments, parseTapdUrl } from "./tapdClient.js";
import { buildTapdEditableHtml } from "./tapdEditableContext.js";
import { countImagesInHtml } from "./tapdDescriptionImages.js";
import { tapdHtmlToPlainText } from "./tapdContext.js";

export interface ResolvedTapdContext extends TapdContext {
  sourceHtml: string;
  commentCount: number;
  commentWarning?: string;
}

export class TapdContextError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

const defaultDependencies = { getStory, getTask, getBug, listTapdComments };

export async function resolveTapdContext(url: string, dependencies = defaultDependencies): Promise<ResolvedTapdContext> {
  const parsed = parseTapdUrl(url);
  if (!parsed.workspaceId || !parsed.itemType || !parsed.itemId) {
    throw new TapdContextError("无法从链接中识别 TAPD 项目、条目类型和 ID", 400);
  }
  const getItem = parsed.itemType === "story" ? dependencies.getStory
    : parsed.itemType === "task" ? dependencies.getTask : dependencies.getBug;
  const [item, commentsResult] = await Promise.all([
    getItem(parsed.itemId, parsed.workspaceId),
    dependencies.listTapdComments(parsed.itemType, parsed.itemId, parsed.workspaceId)
      .then(comments => ({ comments, warning: undefined as string | undefined }))
      .catch(() => ({ comments: [], warning: "TAPD 评论读取失败，已继续加载需求正文" })),
  ]);
  if (!item) throw new TapdContextError("TAPD 条目不存在或当前应用无权访问", 404);
  const sourceHtml = buildTapdEditableHtml(item.description ?? "", commentsResult.comments);
  const title = "title" in item ? item.title ?? item.name : item.name;
  const owner = "current_owner" in item ? item.current_owner ?? item.owner : item.owner;
  return { workspaceId: parsed.workspaceId, itemType: parsed.itemType, itemId: item.id,
    storyId: parsed.itemType === "story" ? item.id : undefined, url,
    title: title || `${parsed.itemType} ${item.id}`, description: tapdHtmlToPlainText(sourceHtml),
    sourceHtml, imageCount: countImagesInHtml(sourceHtml), commentCount: commentsResult.comments.length,
    commentWarning: commentsResult.warning, status: item.status, owner, fetchedAt: new Date().toISOString() };
}
