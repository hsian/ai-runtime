import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WSClient } from "@wecom/aibot-node-sdk";
import type { MessageFrame } from "./client.js";

const directory = mkdtempSync(join(tmpdir(), "wecom-intent-test-"));
process.env.DATABASE_PATH = join(directory, "test.sqlite");
process.env.GIT_ACCESS_TOKEN = "test-only";
process.env.OPERATION_LOG_ENABLED = "false";
process.env.QWECHAT_BOT_ENABLED = "false";
const { resolveIntent } = await import("./intentRouter.js");
const { parseCommand } = await import("./commands.js");
const store = await import("./sessionStore.js");
const jobs = await import("../../services/jobStore.js");
const { closeDatabase } = await import("../../services/database.js");
const { createMessageHandler } = await import("./messageHandler.js");
store.initWecomStore();
after(() => { closeDatabase(); rmSync(directory, { recursive: true, force: true }); });

const session = store.getSession("bot", "alice", "alice", "b2b-composite");

test("greetings, thanks and capabilities never invoke the model or create jobs", async () => {
  for (const text of ["你好", "你好！", "Hello", "谢谢你", "你能做什么"]) {
    const result = await resolveIntent(parseCommand(text), session, async () => { throw new Error("Should not call model"); });
    assert.equal(result.action, "chat");
  }
  assert.equal(jobs.listJobs(session.owner_id).length, 0);
});

test("semantic model decisions preserve read-only questions versus change requests", async () => {
  for (const [text, intent] of [
    ["登录页为什么打不开？", "question"],
    ["怎么修改按钮颜色？先解释，不用动代码", "question"],
    ["能帮我把登录按钮改成蓝色吗？", "plan"],
    ["把它改成刚才说的样子", "plan"],
  ] as const) {
    const result = await resolveIntent(parseCommand(text), session,
      async () => JSON.stringify({ intent, prompt: text, reply: "" }));
    assert.deepEqual(result, { action: intent, text });
  }
});

test("uncertain, failed, invalid or empty classifications never become a change task", async () => {
  for (const output of ["invalid", JSON.stringify({ intent: "execute", prompt: "执行", reply: "" }),
    JSON.stringify({ intent: "plan", prompt: "", reply: "" }),
    JSON.stringify({ intent: "uncertain", prompt: "", reply: "你想先解释还是直接修改？" })]) {
    assert.equal((await resolveIntent(parseCommand("这个处理一下"), session, async () => output)).action, "chat");
  }
  assert.equal((await resolveIntent(parseCommand("这个处理一下"), session, async () => { throw new Error("Unavailable"); })).action, "chat");
});

test("explicit commands bypass semantic routing and cannot be invented by the model", async () => {
  for (const text of ["执行", "取消", "状态", "新会话", "问答：登录逻辑", "修改：按钮颜色", "补充：蓝色"]) {
    const command = parseCommand(text);
    assert.deepEqual(await resolveIntent(command, session, async () => { throw new Error("Should not call model"); }), command);
  }
});

test("classification receives scoped history and current clarification context", async () => {
  const local = store.getSession("bot", "group", "alice", "b2b-composite");
  const other = store.getSession("bot", "group", "bob", "b2b-composite");
  store.recordChatExchange(local, "讨论登录按钮", "希望是什么颜色？");
  store.recordChatExchange(other, "不属于 Alice 的对话", "私有回复");
  const job = jobs.createJob({ prompt: "登录按钮修改", ownerId: local.owner_id });
  jobs.updateJob(job.jobId, { status: "awaiting_input", clarificationQuestions: [
    { id: "color", question: "颜色？", type: "text", required: true },
  ] });
  store.bindJob(local, job.jobId);
  const current = store.getSession("bot", "group", "alice", "b2b-composite");
  const result = await resolveIntent(parseCommand("蓝色"), current, async input => {
    assert.match(input, /讨论登录按钮/);
    assert.match(input, /awaiting_input/);
    assert.doesNotMatch(input, /不属于 Alice/);
    return JSON.stringify({ intent: "clarify", prompt: "蓝色", reply: "" });
  });
  assert.deepEqual(result, { action: "clarify", text: "蓝色" });
  assert.equal((await resolveIntent(parseCommand("你好"), current)).action, "chat");
  assert.equal(jobs.getJob(job.jobId)?.status, "awaiting_input");
  store.resetSession(current);
  assert.deepEqual(store.getChatHistory(store.getSession("bot", "group", "alice", "b2b-composite")), []);
});

test("chat history is bounded and retained across database reopen", () => {
  const local = store.getSession("bot", "history", "alice", "b2b-composite");
  for (let i = 0; i < 10; i++) store.recordChatExchange(local, `user-${i}`, `reply-${i}`);
  assert.equal(store.getChatHistory(local).length, 12);
  closeDatabase(); store.initWecomStore();
  assert.equal(store.getChatHistory(local).at(-1)?.content, "reply-9");
});

test("greeting callbacks send one conversational reply and no job metadata", async () => {
  const replies: string[] = [];
  const client = { async replyStream(_frame: unknown, _id: string, text: string) { replies.push(text); },
    async sendMessage() {} } as unknown as WSClient;
  const handler = createMessageHandler(client, { botId: "chat-bot", secret: "test", projectId: "b2b-composite" });
  const frame = { headers: { req_id: "hello" }, body: { aibotid: "chat-bot", msgid: "hello",
    from: { userid: "alice" }, chattype: "single", msgtype: "text", text: { content: "你好" } } } as MessageFrame;
  handler.handle(frame); handler.handle(frame);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(replies.length, 1);
  assert.doesNotMatch(replies[0], /任务：|计划|编号/);
  assert.equal(jobs.listJobs("wecom:chat-bot:alice").length, 0);
  handler.stop();
});

test("semantic routing shows Thinking in an unfinished stream before the final reply", async () => {
  const replies: { id: string; text: string; finished: boolean }[] = [];
  const client = { async replyStream(_frame: unknown, id: string, text: string, finished: boolean) {
    replies.push({ id, text, finished });
  }, async sendMessage() {} } as unknown as WSClient;
  const handler = createMessageHandler(client, { botId: "thinking-bot", secret: "test", projectId: "b2b-composite" },
    async () => ({ action: "chat", reply: "这是最终回复。" }));
  handler.handle({ headers: { req_id: "thinking" }, body: { aibotid: "thinking-bot", msgid: "thinking",
    from: { userid: "alice" }, chattype: "single", msgtype: "text", text: { content: "今天有点累" } } } as MessageFrame);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(replies.length, 2);
  assert.equal(replies[0].text, "Thinking...");
  assert.equal(replies[0].finished, false);
  assert.equal(replies[1].id, replies[0].id);
  assert.equal(replies[1].finished, true);
  assert.equal(replies[1].text, "这是最终回复。");
  handler.stop();
});
