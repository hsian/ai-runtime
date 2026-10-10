import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { WSClient } from "@wecom/aibot-node-sdk";
import type { MessageFrame } from "./client.js";

const directory = mkdtempSync(join(tmpdir(), "wecom-dialogue-test-"));
process.env.DATABASE_PATH = join(directory, "test.sqlite");
process.env.GIT_ACCESS_TOKEN = "test-only";
process.env.OPERATION_LOG_ENABLED = "false";
process.env.QWECHAT_BOT_ENABLED = "false";
const store = await import("./sessionStore.js");
const { closeDatabase } = await import("../../services/database.js");
const { createJob, updateJob, getJob } = await import("../../services/jobStore.js");
const { getDialogue, setDialogue, rememberChoices } = await import("./dialogueStore.js");
const { resolveIntent } = await import("./intentRouter.js");
const { dispatchCommand } = await import("./jobBridge.js");
const { formatJob, milestoneSignature } = await import("./replies.js");
const { ResponseCoordinator } = await import("./responseCoordinator.js");
const { createMessageHandler } = await import("./messageHandler.js");
const { selectTopic } = await import("./topicStore.js");
const { startWecomBot } = await import("./index.js");
const { jobQueue } = await import("../../services/jobQueue.js");
store.initWecomStore();
after(() => { closeDatabase(); rmSync(directory, { recursive: true, force: true }); });
const options = { botId: "dialogue", secret: "test", projectId: "b2b-composite", codeAllowedUserIds: ["alice", "bob", "fast-user", "integration-user"] };

test("final answers preserve registered choices, survive restart and scope to their topic", async () => {
  const session = store.getSession("dialogue", "choices", "alice", options.projectId);
  const job = createJob({ prompt: "如何撤回？", ownerId: session.owner_id, conversationId: session.conversation_id, taskMode: "question" });
  store.bindJob(session, job.jobId);
  const answer = "背景\n" + "x".repeat(6500) + "\n- **选 A** → 使用 Git revert\n- **选 B** → 手动修改代码";
  store.recordFinalAnswer(job.jobId, answer);
  assert.equal(getDialogue(session)?.choices?.length, 2);
  assert.match(store.getChatHistory(session).at(-1)!.content, /选 B/);
  closeDatabase(); store.initWecomStore();
  assert.equal(getDialogue(session)?.step, "selection");
  const command = await resolveIntent({ action: "auto", text: "A" }, session, async input => {
    assert.match(input, /使用 Git revert/);
    return JSON.stringify({ intent: "revert", reply: "", prompt: "", topicId: session.conversation_id });
  });
  assert.equal(command.action, "revert");
  assert.equal(getDialogue(session), undefined);
  selectTopic(session, "new", "登录问题");
  assert.equal(getDialogue(session), undefined);
});

test("side questions keep pending confirmation and workflow answers do not create jobs", async () => {
  const session = store.getSession("dialogue", "workflow", "alice", options.projectId);
  setDialogue(session, { step: "revert_confirm", sourceJobId: "original" });
  const command = await resolveIntent({ action: "auto", text: "这是 revert 还是改回去？" }, session, async input => {
    assert.match(input, /revert_confirm/);
    return JSON.stringify({ intent: "workflow", reply: "将使用 Git revert，还在等待你确认执行。", prompt: "", topicId: session.conversation_id });
  });
  assert.equal(command.action, "chat");
  await dispatchCommand(session, command, "workflow-question", options);
  assert.equal(getDialogue(session)?.sourceJobId, "original");
  assert.equal(store.listBindings().filter(binding => binding.session_key === session.session_key).length, 0);
});

test("a late answer registers choices in its source topic, not the currently displayed topic", async () => {
  const session = store.getSession("dialogue", "late-answer", "alice", options.projectId);
  const sourceTopic = session.conversation_id;
  const job = createJob({ prompt: "原问题", ownerId: session.owner_id, conversationId: sourceTopic, taskMode: "question" });
  store.bindJob(session, job.jobId);
  selectTopic(session, "new", "穿插问题");
  store.recordFinalAnswer(job.jobId, "A：原问题方案一\nB：原问题方案二");
  assert.equal(getDialogue(session), undefined);
  assert.equal(getDialogue({ ...session, conversation_id: sourceTopic })?.step, "selection");
  const command = await resolveIntent({ action: "auto", text: "A" }, session, async input => {
    assert.match(input, /原问题方案一/);
    return JSON.stringify({ intent: "plan", reply: "", prompt: "按原问题方案一修改", topicId: sourceTopic });
  });
  assert.equal(command.topicId, sourceTopic);
  assert.equal(command.action, "plan");
});

test("revert binds to the last merged code change, not a subsequent question, and only asks confirmation", async () => {
  const session = store.getSession("dialogue", "revert", "alice", options.projectId);
  const code = createJob({ prompt: "标题改红", ownerId: session.owner_id, conversationId: session.conversation_id, taskMode: "code" });
  updateJob(code.jobId, { status: "completed", commitSha: "abc123", branch: "test", mergedToDefaultBranch: "test" });
  store.bindJob(session, code.jobId);
  const question = createJob({ prompt: "解释颜色", ownerId: session.owner_id, conversationId: session.conversation_id, taskMode: "question" });
  updateJob(question.jobId, { status: "completed" });
  store.bindJob(session, question.jobId);
  const response = await dispatchCommand(session, { action: "revert", topicId: session.conversation_id }, "revert-request", options);
  assert.match(response, /Git revert/);
  assert.equal(getDialogue(session)?.sourceJobId, code.jobId);
  assert.equal(getJob(code.jobId)?.revertedFromDefaultAt, undefined);
  await dispatchCommand(session, { action: "cancel" }, "revert-cancel", options);
  assert.equal(getDialogue(session), undefined);
  assert.equal(getJob(code.jobId)?.status, "completed");
  const bob = store.getSession("dialogue", "revert", "bob", options.projectId);
  await assert.rejects(dispatchCommand(bob, { action: "revert", jobId: code.jobId }, "foreign-revert", options), /没有可撤回/);
});

test("multiple topics waiting for A/B selection require a topic name", async () => {
  const session = store.getSession("dialogue", "ambiguous", "alice", options.projectId);
  rememberChoices(session, "A: 第一种\nB: 第二种");
  selectTopic(session, "new", "另一个方案");
  rememberChoices(session, "A: 另一个第一种\nB: 另一个第二种");
  const command = await resolveIntent({ action: "auto", text: "A" }, session, async () => { throw new Error("must not classify an ambiguous choice"); });
  assert.equal(command.action, "chat");
  assert.ok("reply" in command && command.reply.includes("多个话题"));
});

test("compact results omit identifiers, deduplicate preview links and represent revert separately", () => {
  const job = createJob({ prompt: "test", ownerId: "compact" });
  const result = { ...job, status: "completed" as const, implementationSummary: "标题已改红", previewUrl: "http://localhost:7001/",
    previewMessage: "预览地址：http://localhost:7001/" };
  const text = formatJob(result);
  assert.doesNotMatch(text, new RegExp(job.jobId));
  assert.equal(text.match(/http:\/\/localhost:7001\//g)?.length, 1);
  assert.match(formatJob(result, true), new RegExp(job.jobId));
  const reverted = { ...result, revertedFromDefaultAt: "now", revertCommitSha: "def456" };
  assert.match(formatJob(reverted), /Git revert/);
  assert.doesNotMatch(formatJob(reverted), /标题已改红/);
  assert.notEqual(milestoneSignature(result), milestoneSignature(reverted));
});

test("Thinking updates one stream then is replaced by a finished result without more cards", async () => {
  const calls: { id: string; text: string; finish: boolean }[] = [];
  const client = { async replyStream(_frame: unknown, id: string, text: string, finish: boolean) { calls.push({ id, text, finish }); },
    async sendMessage() { throw new Error("unexpected extra card"); } } as unknown as WSClient;
  const coordinator = new ResponseCoordinator(client);
  const frame = { body: { from: { userid: "alice" }, chattype: "single" } } as MessageFrame;
  coordinator.track("job", frame, "stream", "alice");
  const release = coordinator.block("alice");
  await coordinator.refresh();
  assert.equal(calls.length, 0);
  release();
  await coordinator.refresh();
  await coordinator.finish("job", "黑色");
  await coordinator.refresh();
  assert.deepEqual(calls, [{ id: "stream", text: "Thinking...", finish: false }, { id: "stream", text: "黑色", finish: true }]);
  assert.equal(await coordinator.finish("job", "duplicate"), false);
  coordinator.stop();
});

test("slow responses close the waiting stream with a clear status and retain asynchronous fallback", async () => {
  const calls: string[] = [];
  const client = { async replyStream(_frame: unknown, _id: string, text: string) { calls.push(text); } } as unknown as WSClient;
  const coordinator = new ResponseCoordinator(client, 0);
  coordinator.track("slow", { body: { from: { userid: "alice" } } } as MessageFrame, "stream", "alice");
  await coordinator.refresh();
  assert.match(calls[0], /结果稍后通知/);
  assert.doesNotMatch(calls[0], /Thinking/);
  assert.equal(await coordinator.finish("slow", "最终结果"), false);
  coordinator.stop();
});

test("fast task completion cannot finish the stream before its initial response is sent", async () => {
  const calls: { id: string; text: string; finish: boolean }[] = [];
  const client = { async replyStream(_frame: unknown, id: string, text: string, finish: boolean) { calls.push({ id, text, finish }); },
    async sendMessage() {} } as unknown as WSClient;
  const coordinator = new ResponseCoordinator(client);
  const handler = createMessageHandler(client, options, undefined, undefined, coordinator);
  const frame = { headers: { req_id: "fast" }, body: { aibotid: options.botId, msgid: "fast",
    chattype: "single", from: { userid: "fast-user" }, msgtype: "text", text: { content: "修改：你好" } } } as MessageFrame;
  handler.handle(frame);
  await new Promise(resolve => setTimeout(resolve, 30));
  const session = store.getSession(options.botId, "fast-user", "fast-user", options.projectId);
  const job = getJob(session.active_job_id!)!;
  assert.equal(job.status, "awaiting_input");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].finish, false);
  await coordinator.finish(job.jobId, formatJob(job));
  assert.equal(calls[1].id, calls[0].id);
  assert.equal(calls[1].finish, true);
  assert.doesNotMatch(calls[1].text, /Thinking|任务：|项目：/);
  handler.stop(); coordinator.stop();
});

test("explicit revert confirmation queues the original job once without starting a new Agent task", async () => {
  const session = store.getSession("dialogue", "confirm-revert", "alice", options.projectId);
  const source = createJob({ prompt: "修改账套颜色", ownerId: session.owner_id, conversationId: session.conversation_id, taskMode: "code" });
  updateJob(source.jobId, { status: "completed", branch: "test", mergedToDefaultBranch: "test", commitSha: "test-only" });
  store.bindJob(session, source.jobId);
  await dispatchCommand(session, { action: "revert", topicId: session.conversation_id }, "confirm-revert-request", options);
  const original = jobQueue.enqueue;
  const queued: string[] = [];
  jobQueue.enqueue = (id) => { queued.push(id); return 0; };
  try {
    const tracked: string[] = [];
    await dispatchCommand(session, { action: "execute", jobId: source.jobId }, "confirm-revert-execute", options, id => tracked.push(id));
    await dispatchCommand(session, { action: "execute", jobId: source.jobId }, "confirm-revert-again", options);
    assert.deepEqual(queued, [source.jobId]);
    assert.deepEqual(tracked, [source.jobId]);
    assert.equal(getDialogue(session)?.step, "reverting");
    assert.equal(store.listBindings().filter(binding => binding.session_key === session.session_key).length, 1);
  } finally { jobQueue.enqueue = original; setDialogue(session); }
});

test("bot notification integration replaces the waiting stream and drops obsolete progress on reconnect", async () => {
  const target = "integration-user";
  const calls: { target: string; id?: string; text: string; finish?: boolean }[] = [];
  class FakeClient extends EventEmitter {
    connect() { this.emit("authenticated"); }
    disconnect() {}
    async replyStream(frame: MessageFrame, id: string, text: string, finish: boolean) {
      calls.push({ target: frame.body!.from.userid, id, text, finish });
    }
    async sendMessage(target: string, message: { markdown: { content: string } }) { calls.push({ target, text: message.markdown.content }); }
  }
  const client = new FakeClient();
  const stop = startWecomBot(options, () => client as unknown as WSClient);
  try {
    client.emit("message", { headers: { req_id: "integration" }, body: { aibotid: options.botId, msgid: "integration",
      chattype: "single", from: { userid: target }, msgtype: "text", text: { content: "修改：你好" } } } as MessageFrame);
    await new Promise(resolve => setTimeout(resolve, 30));
    const session = store.getSession(options.botId, target, target, options.projectId);
    const job = getJob(session.active_job_id!)!;
    store.queueNotice(job.jobId, "progress:legacy", target, ["旧进度 Thinking... 发起人：raw-id"]);
    client.emit("authenticated");
    await new Promise(resolve => setTimeout(resolve, 50));
    const own = calls.filter(call => call.target === target);
    assert.equal(own.length, 2);
    assert.equal(own[0].finish, false);
    assert.equal(own[1].finish, true);
    assert.equal(own[1].id, own[0].id);
    assert.doesNotMatch(own[1].text, /Thinking|发起人|任务：|raw-id/);
    assert.ok(!store.pendingNotices().some(notice => notice.job_id === job.jobId));
    assert.match(store.getChatHistory({ ...session, conversation_id: job.conversationId! }).at(-1)!.content, /请说明要修改/);
    client.emit("authenticated");
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(calls.filter(call => call.target === target).length, 2);
  } finally { stop(); }
});
