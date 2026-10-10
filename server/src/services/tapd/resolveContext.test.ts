import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveTapdContext, TapdContextError } from "./resolveContext.js";

const storyUrl = "https://www.tapd.cn/123/stories/view/456";
const defaults = {
  async getStory() { return { id: "456", name: "账套选择", description: "<p>展示账套</p>", status: "open" }; },
  async getTask() { return { id: "456", name: "开发任务", description: "<p>任务正文</p>" }; },
  async getBug() { return { id: "456", title: "登录报错", description: "<p>缺陷正文</p>", current_owner: "开发人员" }; },
  async listTapdComments() { return [{ id: "1", author: "产品", description: "<p>兼容手机</p>" }]; },
};

test("shared TAPD resolver reads typed items, comments and keeps the Web context fields", async () => {
  for (const [url, title, type] of [[storyUrl, "账套选择", "story"],
    ["https://www.tapd.cn/123/tasks/view/456", "开发任务", "task"],
    ["https://www.tapd.cn/123/bugs/view/456", "登录报错", "bug"]]) {
    const context = await resolveTapdContext(url, defaults);
    assert.equal(context.title, title);
    assert.equal(context.itemType, type);
    assert.equal(context.commentCount, 1);
    assert.match(context.description, /兼容手机/);
    assert.match(context.sourceHtml, /需求描述/);
    assert.ok(context.fetchedAt);
  }
});

test("failed comments produce a warning without dropping the readable body", async () => {
  const context = await resolveTapdContext(storyUrl, { ...defaults,
    async listTapdComments() { throw new Error("Denied"); } });
  assert.match(context.description, /展示账套/);
  assert.equal(context.commentCount, 0);
  assert.match(context.commentWarning!, /评论读取失败/);
});

test("missing and invalid TAPD items retain precise HTTP errors", async () => {
  await assert.rejects(resolveTapdContext("https://example.com/123/stories/view/456", defaults),
    (error: unknown) => error instanceof TapdContextError && error.status === 400);
  await assert.rejects(resolveTapdContext(storyUrl, { ...defaults, async getStory() { return null; } }),
    (error: unknown) => error instanceof TapdContextError && error.status === 404);
});
