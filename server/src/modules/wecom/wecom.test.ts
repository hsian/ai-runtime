import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WSClient } from "@wecom/aibot-node-sdk";
import type { MessageFrame } from "./client.js";

const directory = mkdtempSync(join(tmpdir(), "ai-runtime-wecom-test-"));
process.env.DATABASE_PATH = join(directory, "test.sqlite");
process.env.GIT_ACCESS_TOKEN = "test-only";
process.env.OPERATION_LOG_ENABLED = "false";
process.env.QWECHAT_BOT_ENABLED = "false";
process.env.CLIENT_COOKIE_SECRET = "wecom-test-cookie-secret";
const store = await import("./sessionStore.js");
const { getDatabase, closeDatabase } = await import("../../services/database.js");
const { createJob, getJob, updateJob, deleteJob } = await import("../../services/jobStore.js");
const { executePlannedJob, parseClarificationAnswers } = await import("../../services/jobActions.js");
const { parseCommand } = await import("./commands.js");
const { splitMessage, formatJob, milestoneSignature } = await import("./replies.js");
const { parseAnswers, dispatchCommand, cleanupObsoletePlan } = await import("./jobBridge.js");
const { createMessageHandler } = await import("./messageHandler.js");
const { getProject } = await import("../../services/projectRegistry.js");
store.initWecomStore();
after(() => { closeDatabase(); rmSync(directory, { recursive: true, force: true }); });

test("control commands must occupy the entire message", () => {
  assert.deepEqual(parseCommand("执行"), { action: "execute", jobId: undefined });
  assert.equal(parseCommand("请修改执行按钮并合并样式").action, "auto");
  assert.deepEqual(parseCommand("问答：登录在哪里实现？"), { action: "question", text: "登录在哪里实现？" });
  const id = "a22aa4b4-bbba-4555-8222-123456789abc";
  assert.deepEqual(parseCommand(`执行 ${id}`), { action: "execute", jobId: id });
});

test("sessions persist and isolate member, group and project context", () => {
  const first = store.getSession("bot", "group-1", "alice", "b2b-composite");
  assert.deepEqual(store.getSession("bot", "group-1", "alice", "b2b-composite"), first);
  for (const other of [store.getSession("bot", "group-1", "bob", "b2b-composite"),
    store.getSession("bot", "group-2", "alice", "b2b-composite"),
    store.getSession("bot", "group-1", "alice", "other")]) {
    assert.notEqual(other.conversation_id, first.conversation_id);
  }
  store.resetSession(first);
  assert.notEqual(store.getSession("bot", "group-1", "alice", "b2b-composite").conversation_id, first.conversation_id);
});

test("notification queue resumes per chunk and deduplicates milestones", () => {
  const session = store.getSession("bot", "group-outbox", "alice", "b2b-composite");
  const job = createJob({ prompt: "test", ownerId: session.owner_id });
  store.bindJob(session, job.jobId);
  store.queueNotice(job.jobId, "completed", session.target_id, ["one", "two"]);
  store.queueNotice(job.jobId, "completed", session.target_id, ["duplicate"]);
  let notices = store.pendingNotices();
  assert.equal(notices.length, 1);
  store.acknowledgeChunk(notices[0].id, 1, 2);
  closeDatabase();
  store.initWecomStore();
  notices = store.pendingNotices();
  assert.equal(notices[0].sent_chunks, 1);
  store.acknowledgeChunk(notices[0].id, 2, 2);
  assert.equal(store.pendingNotices().length, 0);
  deleteJob(job.jobId);
  assert.equal((getDatabase().prepare("SELECT count(*) AS count FROM wecom_job_bindings WHERE job_id = ?")
    .get(job.jobId) as { count: number }).count, 0);
});

test("Unicode messages are split by bytes without corrupting their content", () => {
  const text = "中文𠮷abc".repeat(1500);
  const chunks = splitMessage(text);
  assert.equal(chunks.join(""), text);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => Buffer.byteLength(chunk) <= 3500));
});

test("obsolete greeting plans are cleaned silently, including pending and restarted notifications", async () => {
  const session = store.getSession("bot", "silent-cleanup", "alice", "b2b-composite");
  const job = createJob({ prompt: "你好", ownerId: session.owner_id });
  updateJob(job.jobId, { status: "awaiting_input" });
  store.bindJob(session, job.jobId);
  store.queueNotice(job.jobId, "awaiting_input", session.target_id, ["old clarification"]);
  assert.equal(await cleanupObsoletePlan(session, getJob(job.jobId)!), true);
  assert.equal(getJob(job.jobId)?.status, "cancelled");
  store.queueNotice(job.jobId, "cancelled", session.target_id, ["任务已取消"]);
  assert.ok(!store.pendingNotices().some(notice => notice.job_id === job.jobId));
  closeDatabase(); store.initWecomStore();
  store.queueNotice(job.jobId, "cancelled-after-restart", session.target_id, ["任务已取消"]);
  assert.ok(!store.pendingNotices().some(notice => notice.job_id === job.jobId));
});

test("valid plans are not silently cancelled and explicit cancellation remains visible", async () => {
  const options = { botId: "bot", secret: "test", projectId: "b2b-composite" };
  const session = store.getSession("bot", "explicit-cancel", "alice", options.projectId);
  const job = createJob({ prompt: "把按钮改成蓝色", ownerId: session.owner_id });
  updateJob(job.jobId, { status: "awaiting_input" });
  store.bindJob(session, job.jobId);
  assert.equal(await cleanupObsoletePlan(session, getJob(job.jobId)!), false);
  assert.equal(getJob(job.jobId)?.status, "awaiting_input");
  const reply = await dispatchCommand({ ...session, active_job_id: job.jobId }, { action: "cancel" }, "explicit-cancel-message", options);
  assert.match(reply, /任务已取消/);
  store.queueNotice(job.jobId, "cancelled", session.target_id, ["任务已取消"]);
  const notice = store.pendingNotices().find(notice => notice.job_id === job.jobId);
  assert.ok(notice);
  store.acknowledgeChunk(notice.id, 1, 1);
});

test("clarification answers preserve numbering, multiline text and choice validation", () => {
  const job = createJob({ prompt: "test", ownerId: "clarifier" });
  job.clarificationQuestions = [
    { id: "color", question: "颜色", type: "single_choice", required: true, options: ["蓝色", "绿色"], allowOther: false },
    { id: "scope", question: "范围", type: "text", required: true },
  ];
  const answers = parseAnswers(job, "1. 蓝色\n2. 登录页\n移动端也调整");
  assert.equal(answers[1].value, "登录页\n移动端也调整");
  assert.equal(parseClarificationAnswers(answers, job).error, undefined);
  assert.ok(parseClarificationAnswers([{ questionId: "color", value: "红色" }, answers[1]], job).error);
  assert.ok(parseClarificationAnswers([answers[0]], job).error);
  assert.throws(() => parseAnswers(job, "蓝色，登录页"));
  assert.notEqual(milestoneSignature({ ...job, status: "awaiting_input" }),
    milestoneSignature({ ...job, status: "awaiting_input", clarificationHistory: [{ questions: [], answers: [], answeredAt: "now" }] }));
});

test("cross-member commands and execution of an unconfirmed task are rejected", async () => {
  const alice = store.getSession("bot", "group-control", "alice", "b2b-composite");
  const bob = store.getSession("bot", "group-control", "bob", "b2b-composite");
  const job = createJob({ prompt: "test", ownerId: alice.owner_id });
  store.bindJob(alice, job.jobId);
  assert.throws(() => executePlannedJob(job.jobId, bob.owner_id), /任务不存在/);
  assert.throws(() => executePlannedJob(job.jobId, alice.owner_id), /不可执行/);
  await assert.rejects(dispatchCommand(bob, { action: "status", jobId: job.jobId }, "cross-member", {
    botId: "bot", secret: "test", projectId: "b2b-composite" }), /没有这个任务/);
  assert.equal(getJob(job.jobId)?.status, "pending");
  const project = getProject("b2b-composite");
  assert.equal(project.autoMerge, true);
  assert.equal(project.defaultBranch, "test");
});

test("completion returns the existing preview and merge result", () => {
  const job = createJob({ prompt: "test", ownerId: "preview" });
  const text = formatJob({ ...job, status: "completed", implementationSummary: "已修改按钮",
    mergedToDefaultBranch: "test", previewUrl: "http://192.168.1.20:5174", previewMessage: "预览已启动" });
  assert.match(text, /已修改按钮/);
  assert.match(text, /已合并到：test/);
  assert.match(text, /http:\/\/192.168.1.20:5174/);
});

test("static history replies never retain Thinking even for processing statuses", () => {
  const job = createJob({ prompt: "test", ownerId: "thinking-status" });
  for (const status of ["pending", "planning", "running"] as const) {
    assert.match(formatJob({ ...job, status }), /处理中/);
    assert.doesNotMatch(formatJob({ ...job, status }), /Thinking/);
  }
  for (const status of ["awaiting_input", "awaiting_confirm", "awaiting_merge", "completed", "failed", "cancelled"] as const) {
    assert.doesNotMatch(formatJob({ ...job, status }), /Thinking/);
  }
});

test("repeated callbacks are processed once, including after database reopen", async () => {
  const replies: string[] = [];
  const fake = { async replyStream(_frame: unknown, _id: string, text: string) { replies.push(text); },
    async sendMessage() {} } as unknown as WSClient;
  const options = { botId: "bot-callback", secret: "test", projectId: "b2b-composite" };
  const handler = createMessageHandler(fake, options);
  const frame = { headers: { req_id: "req" }, body: { aibotid: options.botId, msgid: "msg-1",
    chattype: "single", from: { userid: "alice" }, msgtype: "text", text: { content: "帮助" } } } as MessageFrame;
  handler.handle(frame);
  handler.handle(frame);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(replies.length, 1);
  closeDatabase(); store.initWecomStore();
  handler.handle(frame);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(replies.length, 1);
  handler.stop();
});

test("same-session commands observe changes made by the previous command", async () => {
  const options = { botId: "bot-order", secret: "test", projectId: "b2b-composite" };
  const session = store.getSession(options.botId, "alice", "alice", options.projectId);
  const job = createJob({ prompt: "test", ownerId: session.owner_id });
  updateJob(job.jobId, { status: "awaiting_confirm", planSummary: "修改按钮颜色" });
  store.bindJob(session, job.jobId);
  const replies: string[] = [];
  const fake = { async replyStream(_frame: unknown, _id: string, text: string) { replies.push(text); },
    async sendMessage() {} } as unknown as WSClient;
  const handler = createMessageHandler(fake, options);
  for (const [msgid, content] of [["cancel", "取消"], ["status", "状态"]]) {
    handler.handle({ headers: { req_id: msgid }, body: { aibotid: options.botId, msgid,
      chattype: "single", from: { userid: "alice" }, msgtype: "text", text: { content } } } as MessageFrame);
  }
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(getJob(job.jobId)?.status, "cancelled");
  assert.equal(replies.length, 2);
  assert.match(replies[1], /任务已取消/);
  handler.stop();
});

test("duplicate requirements create one shared plan task and never execute without confirmation", async () => {
  const options = { botId: "bot-submit", secret: "test", projectId: "b2b-composite" };
  const replies: string[] = [];
  const fake = { async replyStream(_frame: unknown, _id: string, text: string) { replies.push(text); }, async sendMessage() {} } as unknown as WSClient;
  const handler = createMessageHandler(fake, options);
  const frame = { headers: { req_id: "submit" }, body: { aibotid: options.botId, msgid: "requirement",
    chattype: "single", from: { userid: "alice" }, msgtype: "text", text: { content: "修改：你好" } } } as MessageFrame;
  handler.handle(frame); handler.handle(frame);
  await new Promise(resolve => setTimeout(resolve, 30));
  const session = store.getSession(options.botId, "alice", "alice", options.projectId);
  assert.ok(session.active_job_id);
  const job = getJob(session.active_job_id)!;
  assert.equal(job.status, "awaiting_input");
  assert.equal(job.requiresConfirm, true);
  assert.equal(job.projectId, options.projectId);
  assert.equal(replies[0], "Thinking...");
  assert.equal(store.listBindings().filter(binding => binding.session_key === session.session_key).length, 1);
  await assert.rejects(dispatchCommand(session, { action: "execute" }, "premature-execute", options), /不可执行/);
  assert.equal(getJob(job.jobId)?.status, "awaiting_input");
  handler.stop();
});

test("website plan, clarification, execution validation and cancellation retain their responses", async () => {
  const { default: express } = await import("express");
  const { jobsRouter } = await import("../../routes/jobs.js");
  const app = express();
  app.use(express.json());
  app.use("/api/jobs", jobsRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api/jobs`;
  const post = (path: string, body: unknown) => fetch(base + path, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    const created = await post("/plan", { prompt: "你好", projectId: "b2b-composite" });
    assert.equal(created.status, 202);
    const { jobId } = await created.json() as { jobId: string };
    assert.equal(getJob(jobId)?.status, "awaiting_input");
    const execute = await post(`/${jobId}/execute`, {});
    assert.equal(execute.status, 400);
    assert.match((await execute.json() as { error: string }).error, /不可执行/);
    const clarify = await post(`/${jobId}/clarify`, { answers: [] });
    assert.equal(clarify.status, 400);
    assert.match((await clarify.json() as { error: string }).error, /请回答/);
    const cancel = await post(`/${jobId}/cancel`, {});
    assert.equal(cancel.status, 200);
    assert.deepEqual(await cancel.json(), { ok: true });
    assert.equal(getJob(jobId)?.status, "cancelled");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
