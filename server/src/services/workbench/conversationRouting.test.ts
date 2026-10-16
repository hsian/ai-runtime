import assert from "node:assert/strict";
import { test } from "node:test";
import type { Job } from "../../types.js";

process.env.GIT_ACCESS_TOKEN = "test-only";
const { routeWorkbenchConversation } = await import("./conversationRouting.js");
const { routingAgentOptions } = await import("../conversationRouting.js");
const legacy = await import("../../modules/wecom/conversationRouting.js");
const fixture = (patch: Partial<Job> = {}): Job => ({ jobId: "job", projectId: "project", ownerId: "alice", conversationId: "conversation",
  prompt: "项目开发对话", status: "awaiting_input", createdAt: "now", updatedAt: "now", workbenchProcessedInputs: 0,
  workbenchMessages: [{ id: "input", role: "user", text: "收集下今天的新闻给我", createdAt: "now" }], ...patch });
const result = (intent: string, reply = "", prompt = "") => JSON.stringify({ intent, reply, prompt, relation: "related", topicId: "conversation" });

test("Web and WeCom share the identical tool-free routing options", () => {
  assert.equal(legacy.routingAgentOptions, routingAgentOptions);
  const options = routingAgentOptions();
  assert.equal(options.mode, "conversation"); assert.equal(options.disableTools, true);
  assert.equal("apiDocAccess" in options, false); assert.equal("jsonSchema" in options, false);
  assert.match(options.systemPrompt, /不得声称已搜索或收集实时新闻/);
});

test("arbitrary social requests use semantic routing with bounded history, not repository or full documents", async () => {
  const messages = Array.from({ length: 30 }, (_, i) => ({ id: String(i), role: "user" as const, text: "x".repeat(900), createdAt: "now" }));
  messages.push({ id: "latest", role: "user", text: "收集下今天的新闻给我", createdAt: "now" });
  const reply = await routeWorkbenchConversation(fixture({ workbenchMessages: messages, workbenchProcessedInputs: 30,
    worktreePath: "/private/repository", tapdContext: { workspaceId: "1", title: "任务", description: "d".repeat(9000), url: "https://tapd.invalid", fetchedAt: "now" } }), async raw => {
    const payload = JSON.parse(raw);
    assert.equal(payload.message, "收集下今天的新闻给我"); assert.equal(payload.history.length, 12);
    assert.equal(payload.history[0].content.length, 600); assert.equal(payload.topics[0].tapd.description.length, 600);
    assert.doesNotMatch(raw, /private\/repository|api-doc|baseURL/);
    return result("chat", "当前无法联网收集实时新闻。");
  });
  assert.deepEqual(reply, { message: "当前无法联网收集实时新闻。", needsInput: false });
});

test("business follow-ups preserve the question and are delegated to code analysis", async () => {
  assert.equal(await routeWorkbenchConversation(fixture({ workbenchQuestion: "验证码有效期设为多久？" }), async raw => {
    assert.equal(JSON.parse(raw).lastQuestion, "验证码有效期设为多久？"); return result("clarify", "", "设为三分钟");
  }), undefined);
  assert.equal(await routeWorkbenchConversation(fixture(), async () => result("question", "", "查接口字段")), undefined);
});

test("images bypass the text-only router and retain the original image analysis", async () => {
  const job = fixture(); job.workbenchMessages![0].attachmentIndexes = [0];
  assert.equal(await routeWorkbenchConversation(job, async () => assert.fail("image must not be classified as text-only chat")), undefined);
});

test("malformed output repairs once, but transport errors stop without guessing development intent", async () => {
  let calls = 0;
  assert.deepEqual(await routeWorkbenchConversation(fixture(), async raw => {
    calls++; if (calls === 1) return "not JSON";
    assert.equal(JSON.parse(raw).outputRepair, true); return result("uncertain", "你希望我处理哪个页面？");
  }), { message: "你希望我处理哪个页面？", needsInput: true });
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(routeWorkbenchConversation(fixture(), async () => { calls++; throw new Error("offline"); }), /offline/);
  assert.equal(calls, 1);
});
