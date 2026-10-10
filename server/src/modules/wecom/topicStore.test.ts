import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "wecom-topics-test-"));
process.env.DATABASE_PATH = join(directory, "test.sqlite");
process.env.GIT_ACCESS_TOKEN = "test-only";
process.env.OPERATION_LOG_ENABLED = "false";
process.env.QWECHAT_BOT_ENABLED = "false";
const store = await import("./sessionStore.js");
const topics = await import("./topicStore.js");
const jobs = await import("../../services/jobStore.js");
const { closeDatabase } = await import("../../services/database.js");
const { resolveIntent } = await import("./intentRouter.js");
const { parseCommand } = await import("./commands.js");
const { dispatchCommand } = await import("./jobBridge.js");
store.initWecomStore();
after(() => { closeDatabase(); rmSync(directory, { recursive: true, force: true }); });
const options = { botId: "bot", secret: "test", projectId: "b2b-composite",
  codeAllowedUserIds: ["controls", "unique-control", "topic-list"] };

function makeTopics(user: string, pending = false) {
  const session = store.getSession("bot", user, user, options.projectId);
  const add = (title: string, result: string) => {
    topics.selectTopic(session, "new", title);
    const job = jobs.createJob({ prompt: title, ownerId: session.owner_id, projectId: options.projectId,
      conversationId: session.conversation_id });
    jobs.updateJob(job.jobId, { status: pending ? "awaiting_confirm" : "completed", message: result, planSummary: pending ? title : undefined });
    store.bindJob(session, job.jobId);
    store.recordChatExchange(session, title, result);
    return { topicId: session.conversation_id, jobId: job.jobId };
  };
  const a = add("账套列表标题颜色", "账套列表标题是黑色，文件 accountSelect/index.vue。");
  const b = add("登录按钮报错", "登录按钮请求缺少参数，文件 login/index.vue。");
  return { session: store.getSession("bot", user, user, options.projectId), a, b };
}

test("A/B/A routing restores A history and never feeds B task results to A jobs", async () => {
  const { session, a, b } = makeTopics("interleaved");
  const command = await resolveIntent(parseCommand("账套列表的字号呢？"), session, async input => {
    const context = JSON.parse(input);
    assert.ok(context.topics.some((topic: { id: string }) => topic.id === a.topicId));
    assert.ok(context.topics.some((topic: { id: string }) => topic.id === b.topicId));
    return JSON.stringify({ intent: "question", prompt: "账套选择页账套列表标题字号是多少？", reply: "", topicId: a.topicId });
  });
  assert.equal(command.topicId, a.topicId);
  await dispatchCommand(session, { action: "chat", reply: "继续账套列表话题。", topicId: command.topicId }, "select-a", options);
  assert.equal(session.active_job_id, a.jobId);
  const job = jobs.createJob({ prompt: "字号是多少？", ownerId: session.owner_id,
    projectId: options.projectId, conversationId: session.conversation_id });
  const history = JSON.stringify(job.conversationHistory);
  assert.match(history, /账套列表标题是黑色/);
  assert.doesNotMatch(history, /登录按钮|login\/index/);
  assert.equal(topics.listTopics(session).find(topic => topic.id === b.topicId)?.activeTask?.jobId, b.jobId);
});

test("ambiguous references and missing or foreign topic IDs never dispatch a modification", async () => {
  const { session } = makeTopics("ambiguous");
  const other = makeTopics("other-user");
  for (const output of [
    { intent: "uncertain", prompt: "", reply: "你指账套列表还是登录按钮？", topicId: "" },
    { intent: "plan", prompt: "把它改成蓝色", reply: "" },
    { intent: "plan", prompt: "把它改成蓝色", reply: "", topicId: other.a.topicId },
  ]) {
    const command = await resolveIntent(parseCommand("把它改成蓝色"), session, async () => JSON.stringify(output));
    assert.equal(command.action, "chat");
  }
  assert.throws(() => topics.selectTopic(session, other.a.topicId), /不属于当前会话/);
});

test("clarification is validated against the selected topic instead of the last active topic", async () => {
  const { session, a } = makeTopics("clarification");
  jobs.updateJob(a.jobId, { status: "awaiting_input", clarificationQuestions: [
    { id: "color", question: "账套列表颜色？", type: "text", required: true },
  ] });
  const command = await resolveIntent(parseCommand("账套列表用蓝色"), session, async () => JSON.stringify({
    intent: "clarify", prompt: "蓝色", reply: "", topicId: a.topicId,
  }));
  assert.equal(command.action, "clarify");
  assert.equal(command.topicId, a.topicId);
  const invalid = await resolveIntent(parseCommand("蓝色"), session, async () => JSON.stringify({
    intent: "clarify", prompt: "蓝色", reply: "", topicId: "new",
  }));
  assert.equal(invalid.action, "chat");
});

test("multiple pending tasks require explicit control and cancelling A leaves B untouched", async () => {
  const { session, a, b } = makeTopics("controls", true);
  for (const action of ["execute", "cancel"] as const) {
    await assert.rejects(dispatchCommand(session, { action }, `ambiguous-${action}`, options), /有多个任务/);
  }
  assert.equal(jobs.getJob(a.jobId)?.status, "awaiting_confirm");
  assert.equal(jobs.getJob(b.jobId)?.status, "awaiting_confirm");
  await dispatchCommand(session, { action: "cancel", jobId: a.jobId }, "cancel-a-only", options);
  assert.equal(jobs.getJob(a.jobId)?.status, "cancelled");
  assert.equal(jobs.getJob(b.jobId)?.status, "awaiting_confirm");
  assert.deepEqual(parseCommand(`补充 ${b.jobId}：蓝色`), { action: "clarify", jobId: b.jobId, text: "蓝色" });
});

test("a unique pending task remains controllable after switching to another completed topic", async () => {
  const { session, a, b } = makeTopics("unique-control");
  jobs.updateJob(a.jobId, { status: "awaiting_confirm", planSummary: "调整账套标题" });
  assert.equal(session.active_job_id, b.jobId);
  await dispatchCommand(session, { action: "cancel" }, "cancel-unique", options);
  assert.equal(jobs.getJob(a.jobId)?.status, "cancelled");
  assert.equal(jobs.getJob(b.jobId)?.status, "completed");
  assert.equal(session.conversation_id, a.topicId);
});

test("topic list is scoped to the member and explicit fresh plans preserve existing pending topics", async () => {
  const { session, a, b } = makeTopics("topic-list", true);
  const reply = await dispatchCommand(session, parseCommand("话题"), "list-topics", options);
  assert.match(reply, /账套列表标题颜色/);
  assert.match(reply, /登录按钮报错/);
  assert.ok(reply.includes(a.jobId) && reply.includes(b.jobId));
  const other = store.getSession("bot", "topic-list", "other-member", options.projectId);
  const otherReply = await dispatchCommand(other, parseCommand("话题"), "other-list", options);
  assert.ok(!otherReply.includes(a.jobId));
  // The greeting guard finishes locally, so no real Agent or Git process is launched.
  await dispatchCommand(session, parseCommand("修改：你好"), "fresh-local-plan", options);
  assert.notEqual(session.conversation_id, a.topicId);
  assert.notEqual(session.conversation_id, b.topicId);
  assert.equal(jobs.getJob(a.jobId)?.status, "awaiting_confirm");
  assert.equal(jobs.getJob(b.jobId)?.status, "awaiting_confirm");
  const fresh = store.getSession("bot", "topic-list", "topic-list", options.projectId);
  assert.deepEqual(jobs.getJob(fresh.active_job_id!)?.conversationHistory, []);
});

test("per-topic bounded history survives switching and restart; new conversation archives old candidates", () => {
  const { session, a, b } = makeTopics("persistence");
  for (let i = 0; i < 10; i++) store.recordChatExchange(session, `B-${i}`, `answer-${i}`);
  topics.selectTopic(session, a.topicId);
  assert.equal(store.getChatHistory(session).length, 2);
  assert.match(store.getChatHistory(session)[1].content, /账套列表/);
  closeDatabase(); store.initWecomStore();
  topics.selectTopic(session, b.topicId);
  assert.equal(store.getChatHistory(session).length, 12);
  store.resetSession(session);
  const fresh = store.getSession("bot", "persistence", "persistence", options.projectId);
  assert.deepEqual(store.getChatHistory(fresh), []);
  assert.ok(topics.topicCandidates(fresh).every(topic => topic.id !== a.topicId && topic.id !== b.topicId));
  topics.selectTopic(fresh, a.topicId);
  assert.match(store.getChatHistory(fresh)[1].content, /账套列表/);
});

test("topic snapshots are bounded and completion of a question does not hide a pending plan", () => {
  const { session, a } = makeTopics("bounded", true);
  topics.selectTopic(session, a.topicId);
  const question = jobs.createJob({ prompt: "查询字号", ownerId: session.owner_id, projectId: options.projectId,
    conversationId: session.conversation_id, taskMode: "question" });
  jobs.updateJob(question.jobId, { status: "completed", message: "字号16px。".repeat(1000) });
  store.bindJob(session, question.jobId, false);
  const snapshot = topics.topicCandidates(session).find(topic => topic.id === a.topicId)!;
  assert.equal(snapshot.activeTask?.jobId, a.jobId);
  assert.equal(snapshot.activeTask?.status, "awaiting_confirm");
  assert.ok(snapshot.result && snapshot.result.length <= 2000);
});
