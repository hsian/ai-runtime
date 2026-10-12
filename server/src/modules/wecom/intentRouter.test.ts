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
const { routingAgentOptions } = await import("./conversationRouting.js");
const { parseCommand } = await import("./commands.js");
const store = await import("./sessionStore.js");
const jobs = await import("../../services/jobStore.js");
const { closeDatabase, getDatabase } = await import("../../services/database.js");
const { createMessageHandler } = await import("./messageHandler.js");
store.initWecomStore();
after(() => { closeDatabase(); rmSync(directory, { recursive: true, force: true }); });

const session = store.getSession("bot", "alice", "alice", "b2b-composite");

test("intent classification uses locally validated JSON without native CLI schema requirements", () => {
  const options = routingAgentOptions("request");
  assert.equal(options.mode, "conversation");
  assert.equal(options.disableTools, true);
  assert.equal("jsonSchema" in options, false);
  assert.match(options.systemPrompt, /复制合同页也要改/);
  assert.match(options.systemPrompt, /输出 JSON schema/);
});

test("request memory keeps ordinary replies but excludes task output and unknown legacy assistant rows", () => {
  const local = store.getSession("bot", "memory-sources", "alice", "b2b-composite");
  store.recordChatExchange(local, "你好", "你好，我在。");
  store.recordChatExchange(local, "查询计划", "Old task output", "task");
  getDatabase().prepare("INSERT INTO wecom_chat_history (session_key, conversation_id, role, content) VALUES (?, ?, 'assistant', ?)")
    .run(local.session_key, local.conversation_id, "Unknown legacy output");
  const before = store.getConversationHistory(local);
  assert.ok(before.some(turn => turn.content === "你好，我在。"));
  assert.ok(before.some(turn => turn.content === "查询计划"));
  assert.ok(!before.some(turn => turn.content === "Old task output"));
  assert.ok(!before.some(turn => turn.content === "Unknown legacy output"));
  assert.ok(store.getChatHistory(local).some(turn => turn.content === "Old task output"));
  closeDatabase(); store.initWecomStore();
  assert.deepEqual(store.getConversationHistory(local), before);
});

test("natural change follow-ups use the linked TAPD topic and preserve the single-use engine", async () => {
  const local = store.getSession("bot", "copy-contract", "alice", "b2b-composite");
  const { saveTopicTapd } = await import("./tapdStore.js");
  saveTopicTapd(local, { snapshotId: "copy-contract", attachments: [], warnings: [], context: {
    url: "https://www.tapd.cn/34579999/prong/stories/view/1134579999001021751",
    workspaceId: "34579999", itemType: "story", itemId: "1134579999001021751",
    title: "合同录入页面优化", description: "新增/编辑合同、复制合同页面也要修改", commentCount: 0,
    fetchedAt: new Date().toISOString(),
  } });
  store.recordChatExchange(local, "需求本身已经实现，只是产品增加了一处", "已读取合同录入页面优化需求");
  const command = { ...parseCommand('#codex “复制合同页”也要修改'), topicId: local.conversation_id };
  const result = await resolveIntent(command, local, async (input, stage) => {
    const data = JSON.parse(input);
    if (stage === "context") {
      assert.equal(data.linkedTopicId, local.conversation_id);
      assert.match(input, /复制合同页面也要修改/);
      assert.match(input, /需求本身已经实现/);
    } else {
      assert.equal(data.linkedReference, true);
      assert.equal(data.topics, undefined);
    }
    return JSON.stringify({ intent: "plan", prompt: "现有需求已经实现，仅将新增调整同步到复制合同页",
      reply: "", topicId: local.conversation_id, topicTitle: null });
  });
  assert.equal(result.action, "plan");
  assert.equal(result.topicId, local.conversation_id);
  assert.equal(result.agentProvider, "codex");
});

test("connection failure does not blame user wording or request command syntax", async () => {
  const result = await resolveIntent(parseCommand("复制合同页也要修改"), session,
    async () => { throw new Error("Intent connection unavailable"); });
  assert.equal(result.action, "chat");
  if (result.action === "chat") {
    assert.match(result.reply, /消息处理失败/);
    assert.doesNotMatch(result.reply, /问答：|修改：|没判断清楚/);
  }
});

test("a pending plan is absent from both request understanding and context selection", async () => {
  const local = store.getSession("bot", "renew-plan", "alice", "b2b-composite");
  const old = jobs.createJob({ prompt: "旧需求", ownerId: local.owner_id, conversationId: local.conversation_id });
  jobs.updateJob(old.jobId, { status: "awaiting_confirm", requiresConfirm: true, planSummary: "Old plan body" });
  store.bindJob(local, old.jobId);
  let calls = 0;
  const command = await resolveIntent(parseCommand("#codex 这需求已经实现，只补齐复制页面"), local, async (input, stage) => {
    calls++;
    const data = JSON.parse(input);
    assert.doesNotMatch(input, /Old plan body|awaiting_confirm/);
    assert.equal(data.message, "这需求已经实现，只补齐复制页面");
    if (stage === "request") assert.equal(data.topics, undefined);
    else assert.equal(data.request.intent, "plan");
    return JSON.stringify({ intent: "plan", reply: "", prompt: data.message, topicId: local.conversation_id });
  });
  assert.equal(calls, 2);
  assert.equal(command.action, "plan");
  assert.equal(command.agentProvider, "codex");
});

test("an independent request bypasses old topics, creates a clean job and supersedes the old draft", async () => {
  const local = store.getSession("bot", "switch-request", "alice", "b2b-composite");
  const { saveTopicTapd } = await import("./tapdStore.js");
  saveTopicTapd(local, { snapshotId: "old-contract", attachments: [], warnings: [], context: {
    url: "https://www.tapd.cn/34579999/prong/stories/view/1134579999001021751",
    workspaceId: "34579999", itemType: "story", itemId: "1134579999001021751",
    title: "合同需求", description: "合同相关资料", commentCount: 0, fetchedAt: new Date().toISOString(),
  } });
  const old = jobs.createJob({ prompt: "修改合同", ownerId: local.owner_id, conversationId: local.conversation_id });
  jobs.updateJob(old.jobId, { status: "awaiting_confirm", requiresConfirm: true, planSummary: "Old contract plan" });
  store.bindJob(local, old.jobId);
  store.recordChatExchange(local, "修改合同", "Old contract plan", "task");
  let calls = 0;
  const command = await resolveIntent(parseCommand("#codex 登录按钮改成蓝色"), local, async (input, stage) => {
    calls++;
    assert.equal(stage, "request");
    assert.doesNotMatch(input, /Old contract plan|awaiting_confirm|合同相关资料/);
    assert.equal(JSON.parse(input).topics, undefined);
    return JSON.stringify({ intent: "plan", relation: "new", prompt: "登录按钮改成蓝色", reply: "", topicTitle: "登录按钮" });
  });
  assert.equal(calls, 1);
  assert.equal(command.topicId, "new");
  const { dispatchCommand } = await import("./jobBridge.js");
  const stopBeforeAgent = new Error("Stop before agent");
  let latest = "";
  await assert.rejects(dispatchCommand(local, command, "switch-to-login", {
    botId: "bot", secret: "test", projectId: "b2b-composite", codeAllowedUserIds: ["alice"],
  }, id => { latest = id; throw stopBeforeAgent; }), error => error === stopBeforeAgent);
  const created = jobs.getJob(latest)!;
  assert.equal(created.prompt, "登录按钮改成蓝色");
  assert.deepEqual(created.conversationHistory, []);
  assert.equal(created.tapdContext, undefined);
  assert.equal(created.agentProvider, "codex");
  assert.equal(jobs.getJob(old.jobId)?.status, "cancelled");
});

test("context selection cannot convert a new change goal into old-plan status or a read-only question into a change", async () => {
  const local = store.getSession("bot", "intent-lock", "alice", "b2b-composite");
  const before = jobs.listJobs(local.owner_id).length;
  for (const [initial, changed] of [["plan", "workflow"], ["question", "plan"]]) {
    const result = await resolveIntent(parseCommand("处理当前问题"), local, async (_input, stage) => JSON.stringify({
      intent: stage === "request" ? initial : changed, relation: "related", prompt: "当前目标", reply: "催执行", topicId: local.conversation_id,
    }));
    assert.equal(result.action, "chat");
    if (result.action === "chat") assert.match(result.reply, /处理失败/);
  }
  assert.equal(jobs.listJobs(local.owner_id).length, before);
});

test("workflow status renders the recorded plan and engine, never the classifier's invented summary", async () => {
  const local = store.getSession("bot", "real-status", "alice", "b2b-composite");
  const old = jobs.createJob({ prompt: "旧需求", ownerId: local.owner_id, conversationId: local.conversation_id, agentProvider: "codex" });
  jobs.updateJob(old.jobId, { status: "awaiting_confirm", requiresConfirm: true,
    planSummary: "Actual recorded plan" });
  store.bindJob(local, old.jobId);
  const command = await resolveIntent(parseCommand("现在是什么状态？"), local, async () => JSON.stringify({
    intent: "workflow", reply: "Invented plan", prompt: "", topicId: local.conversation_id }));
  assert.equal(command.action, "chat");
  if (command.action === "chat") {
    assert.match(command.reply, /不是本次新生成/);
    assert.match(command.reply, /Actual recorded plan/);
    assert.match(command.reply, /本次回答执行引擎为 codex。$/);
    assert.doesNotMatch(command.reply, /Invented plan/);
  }
});

test("greetings, thanks and capabilities never invoke the model or create jobs", async () => {
  const before = jobs.listJobs(session.owner_id).length;
  for (const text of ["你好", "你好！", "Hello", "谢谢你", "你能做什么"]) {
    const result = await resolveIntent(parseCommand(text), session, async () => { throw new Error("Should not call model"); });
    assert.equal(result.action, "chat");
  }
  assert.equal(jobs.listJobs(session.owner_id).length, before);
});

test("semantic model decisions preserve read-only questions versus change requests", async () => {
  for (const [text, intent] of [
    ["登录页为什么打不开？", "question"],
    ["怎么修改按钮颜色？先解释，不用动代码", "question"],
    ["能帮我把登录按钮改成蓝色吗？", "plan"],
    ["把它改成刚才说的样子", "plan"],
  ] as const) {
    const result = await resolveIntent(parseCommand(text), session,
      async () => JSON.stringify({ intent, relation: "new", prompt: text, reply: "" }));
    assert.deepEqual(result, { action: intent, text, topicId: "new", topicTitle: "" });
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
    assert.doesNotMatch(input, /awaiting_input/);
    assert.match(input, /颜色？/);
    assert.doesNotMatch(input, /不属于 Alice/);
    return JSON.stringify({ intent: "clarify", prompt: "蓝色", reply: "", topicId: current.conversation_id });
  });
  assert.equal(result.action, "clarify");
  assert.equal(result.topicId, current.conversation_id);
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
