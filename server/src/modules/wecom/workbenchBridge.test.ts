import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WSClient } from "@wecom/aibot-node-sdk";
import type { MessageFrame } from "./client.js";

const directory = mkdtempSync(join(tmpdir(), "wecom-workbench-test-"));
process.env.DATABASE_PATH = join(directory, "test.sqlite");
process.env.GIT_ACCESS_TOKEN = "test-only";
process.env.CLIENT_COOKIE_SECRET = "test-workbench-cookie";
process.env.OPERATION_LOG_ENABLED = "false";
process.env.QWECHAT_BOT_ENABLED = "false";
const { getDatabase, closeDatabase } = await import("../../services/database.js");
const { initWecomStore } = await import("./sessionStore.js");
const { createUser } = await import("../../services/auth.js");
const { createJob, getJob, updateJob } = await import("../../services/jobStore.js");
const { createWorkbenchBridge, initWorkbenchBridgeStore } = await import("./workbenchBridge.js");
const { parseWorkbenchRecipients } = await import("./config.js");
const { createMessageHandler } = await import("./messageHandler.js");
initWecomStore();
initWorkbenchBridgeStore();
const alice = createUser({ username: "alice-web", displayName: "同名", tapdOwnerName: "同名", password: "test-only-password", role: "member" });
const bob = createUser({ username: "bob-web", displayName: "同名", tapdOwnerName: "同名", password: "test-only-password", role: "member" });
const carol = createUser({ username: "carol-web", displayName: "独立姓名", tapdOwnerName: "TAPD独立姓名", password: "test-only-password", role: "member" });
after(() => { closeDatabase(); rmSync(directory, { recursive: true, force: true }); });
const options = { botId: "workbench-bot", secret: "test", projectId: "b2b-composite", workbenchRecipients: { "alice-web": "alice-wecom", "bob-web": "bob-wecom" }, codeAllowedUserIds: ["alice-wecom", "bob-wecom"] };
const make = (owner = alice.id) => {
  const job = createJob({ prompt: "短信登录任务", ownerId: "same-browser", projectId: "b2b-composite", conversationId: `conversation-${Math.random()}`, taskMode: "code" });
  updateJob(job.jobId, { workbenchSession: true, workbenchUserId: owner, status: "awaiting_input", workbenchNeedsInput: true,
    workbenchQuestion: "验证码有效期多久？", workbenchProcessedInputs: 1, worktreePath: "/isolated/task" });
  return job;
};
const reset = () => {
  getDatabase().prepare("DELETE FROM wecom_workbench_notices").run();
  for (const job of (getDatabase().prepare("SELECT job_id FROM jobs").all() as { job_id: string }[])) updateJob(job.job_id, { workbenchNeedsInput: false, status: "completed" });
};
function setup(codeAllowed = options.codeAllowedUserIds) {
  const sent: { target: string; text: string }[] = [];
  const received: { id: string; text: string }[] = [];
  const bridge = createWorkbenchBridge({ ...options, codeAllowedUserIds: codeAllowed }, async (target, text) => { sent.push({ target, text }); }, undefined, (id, text) => {
    received.push({ id, text });
    const job = getJob(id)!;
    updateJob(id, { workbenchNeedsInput: false, status: "planning", workbenchMessages: [...(job.workbenchMessages || []), { id: `reply-${received.length}`, role: "user", text, createdAt: new Date().toISOString() }] });
  });
  return { bridge, sent, received };
}

test("explicit one-to-one username mapping rejects ambiguous recipients", () => {
  assert.deepEqual(parseWorkbenchRecipients('{"alice-web":"alice-wecom"}'), { "alice-web": "alice-wecom" });
  assert.throws(() => parseWorkbenchRecipients('{"alice-web":"same","bob-web":"same"}'), /只能绑定一个/);
  assert.throws(() => parseWorkbenchRecipients('{" alice-web":"id"}'), /准确/);
});
test("configured names route pushes and replies to the same authenticated account", async () => {
  reset(); const job = make(carol.id);
  const sent: string[] = []; const received: string[] = [];
  const bridge = createWorkbenchBridge({ ...options, workbenchRecipients: {},
    workbenchNameRecipients: { "独立姓名": "carol-wecom" }, codeAllowedUserIds: ["carol-wecom"] },
    async target => { sent.push(target); }, undefined, id => { received.push(id); });
  bridge.reconcile(); await bridge.flush();
  assert.deepEqual(sent, ["carol-wecom"]);
  await bridge.reply("carol-wecom", `补充 ${job.jobId}：三分钟`);
  assert.deepEqual(received, [job.jobId]);
});
test("duplicate names and conflicting display/TAPD mappings never send or consume questions", async () => {
  reset(); make(); make(bob.id); make(carol.id);
  const sent: string[] = []; const received: string[] = [];
  const bridge = createWorkbenchBridge({ ...options, workbenchRecipients: {}, workbenchNameRecipients: {
    "同名": "shared-wecom", "独立姓名": "carol-wecom", "TAPD独立姓名": "different-wecom",
  } }, async target => { sent.push(target); }, undefined, id => { received.push(id); });
  bridge.reconcile(); await bridge.flush();
  assert.deepEqual(sent, []);
  assert.match((await bridge.reply("shared-wecom", "待补充"))!, /尚未绑定/);
  assert.match((await bridge.reply("carol-wecom", "待补充"))!, /尚未绑定/);
  assert.deepEqual(received, []);
});
test("TAPD name fallback is available while an explicit username mapping takes precedence", async () => {
  reset(); make(carol.id);
  const sent: string[] = [];
  const fallback = createWorkbenchBridge({ ...options, workbenchRecipients: {}, workbenchNameRecipients: { "TAPD独立姓名": "carol-wecom" } },
    async target => { sent.push(target); });
  fallback.reconcile(); await fallback.flush();
  assert.deepEqual(sent, ["carol-wecom"]);
  reset(); make(carol.id);
  const override = createWorkbenchBridge({ ...options, workbenchRecipients: { "carol-web": "explicit-wecom" },
    workbenchNameRecipients: { "独立姓名": "carol-wecom", "TAPD独立姓名": "different-wecom" } }, async target => { sent.push(target); });
  override.reconcile(); await override.flush();
  assert.deepEqual(sent, ["carol-wecom", "explicit-wecom"]);
});
test("notices target exact authenticated accounts, not shared browser or display/TAPD names", async () => {
  reset(); const a = make(); const b = make(bob.id); const legacy = make(); updateJob(legacy.jobId, { workbenchUserId: undefined });
  const state = setup(); state.bridge.reconcile(); state.bridge.reconcile(); await state.bridge.flush();
  assert.equal(state.sent.length, 2);
  assert.ok(state.sent.find(item => item.target === "alice-wecom")?.text.includes(a.jobId));
  assert.ok(state.sent.find(item => item.target === "bob-wecom")?.text.includes(b.jobId));
  assert.ok(state.sent.every(item => !item.text.includes(legacy.jobId)));
  await state.bridge.flush(); closeDatabase(); initWecomStore(); await state.bridge.flush();
  assert.equal(state.sent.length, 2, "delivered questions survive restart without duplicate push");
});
test("another WeCom user cannot reply to the workbench owner's question", async () => {
  reset(); const job = make(); const state = setup();
  assert.match((await state.bridge.reply("bob-wecom", `补充 ${job.jobId}：三分钟`))!, /不属于/);
  assert.match((await state.bridge.reply("unknown", `补充 ${job.jobId}：三分钟`))!, /尚未绑定/);
  assert.equal(state.received.length, 0);
  assert.equal(getJob(job.jobId)?.workbenchNeedsInput, true);
});
test("single delivered question accepts natural reply in the original job, duplicate answer is rejected", async () => {
  reset(); const job = make(); const state = setup(); state.bridge.reconcile(); await state.bridge.flush();
  assert.match((await state.bridge.reply("alice-wecom", "三分钟"))!, /原任务/);
  assert.deepEqual(state.received, [{ id: job.jobId, text: "三分钟" }]);
  assert.equal(getJob(job.jobId)?.worktreePath, "/isolated/task");
  assert.match((await state.bridge.reply("alice-wecom", `补充 ${job.jobId}：五分钟`))!, /不需要补充/);
  assert.equal(state.received.length, 1);
});
test("multiple pending workbench jobs require an explicit full task ID", async () => {
  reset(); make(); const second = make(); const state = setup(); state.bridge.reconcile(); await state.bridge.flush();
  assert.match((await state.bridge.reply("alice-wecom", "三分钟"))!, /多个/);
  assert.equal(state.received.length, 0);
  await state.bridge.reply("alice-wecom", `补充 ${second.jobId}：三分钟`);
  assert.equal(state.received[0].id, second.jobId);
});
test("a Web answer invalidates queued bot questions and stale bot replies", async () => {
  reset(); const job = make(); const state = setup(); state.bridge.reconcile();
  updateJob(job.jobId, { workbenchNeedsInput: false, status: "running" });
  await state.bridge.flush(); assert.equal(state.sent.length, 0);
  assert.match((await state.bridge.reply("alice-wecom", `补充 ${job.jobId}：三分钟`))!, /不需要补充/);
  assert.equal(state.received.length, 0);
});
test("unaddressed legacy supplements stay in the bot handler when no workbench question is pending", async () => {
  reset(); const state = setup();
  assert.equal(await state.bridge.reply("alice-wecom", "补充：验证码有效期三分钟"), undefined);
  assert.equal(state.received.length, 0);
});

test("implementation questions do not push while analysis questions still do", async () => {
  reset(); const implementation = make(); const analysis = make(bob.id);
  updateJob(implementation.jobId, { workbenchInputSource: "implementation" });
  updateJob(analysis.jobId, { workbenchInputSource: "analysis" });
  const state = setup(); state.bridge.reconcile(); await state.bridge.flush();
  assert.deepEqual(state.sent.map(item => item.target), ["bob-wecom"]);
});

test("real code awaiting Review notifies its owner once per commit and ignores plan-only tasks", async () => {
  reset(); const job = make(); const planOnly = make(bob.id);
  updateJob(job.jobId, { status: "awaiting_merge", workbenchNeedsInput: false, commitSha: "code-1", workbenchBaseCommitSha: "base", workbenchHasCodeChanges: true, workbenchTurnRunning: false });
  updateJob(planOnly.jobId, { status: "awaiting_merge", workbenchNeedsInput: false, commitSha: "base", workbenchBaseCommitSha: "base", workbenchHasCodeChanges: false });
  const state = setup(); state.bridge.reconcile(); await state.bridge.flush();
  assert.equal(state.sent.length, 1);
  assert.equal(state.sent[0].target, "alice-wecom");
  assert.match(state.sent[0].text, /代码已完成.*Review/);
  assert.match(state.sent[0].text, /查看代码 Diff/);
  state.bridge.reconcile(); await state.bridge.flush();
  assert.equal(state.sent.length, 1);
  updateJob(job.jobId, { commitSha: "code-2" });
  state.bridge.reconcile(); await state.bridge.flush();
  assert.equal(state.sent.length, 2);
});

test("queued Review notices are discarded when the user resumes or finishes the task", async () => {
  reset(); const job = make();
  updateJob(job.jobId, { status: "awaiting_merge", workbenchNeedsInput: false, commitSha: "code-1", workbenchHasCodeChanges: true });
  const state = setup(); state.bridge.reconcile();
  updateJob(job.jobId, { status: "running", workbenchTurnRunning: true });
  await state.bridge.flush();
  assert.equal(state.sent.length, 0);
});
test("partially delivered notices resume at the next chunk after reconnect", async () => {
  reset(); const job = make(); updateJob(job.jobId, { workbenchQuestion: "需要确认的业务字段。".repeat(900) });
  const sent: string[] = [];
  let calls = 0;
  const first = createWorkbenchBridge(options, async (_target, text) => {
    if (++calls === 2) throw new Error("temporary disconnect");
    sent.push(text);
  });
  first.reconcile(); await first.flush(); first.stop();
  assert.equal(sent.length, 1);
  const next = createWorkbenchBridge(options, async (_target, text) => { sent.push(text); });
  next.reconcile(); await next.flush();
  assert.ok(sent.length > 2);
  assert.equal(sent.filter(text => text.startsWith("**任务需要你补充信息**")).length, 1);
  const before = sent.length; await next.flush(); assert.equal(sent.length, before);
});
test("disabled accounts, groups and missing code permission cannot submit supplements", async () => {
  reset(); const job = make(); const state = setup([]);
  assert.match((await state.bridge.reply("alice-wecom", `补充 ${job.jobId}：三分钟`))!, /执行权限/);
  assert.match((await state.bridge.reply("alice-wecom", `补充 ${job.jobId}：三分钟`, { group: true }))!, /私聊/);
  getDatabase().prepare("UPDATE users SET enabled = 0 WHERE id = ?").run(alice.id);
  state.bridge.reconcile(); await state.bridge.flush(); assert.equal(state.sent.length, 0);
  assert.match((await state.bridge.reply("alice-wecom", `补充 ${job.jobId}：三分钟`))!, /尚未绑定/);
  getDatabase().prepare("UPDATE users SET enabled = 1 WHERE id = ?").run(alice.id);
  assert.equal(state.received.length, 0);
});
test("message handler routes workbench replies before legacy AI routing and deduplicates messages", async () => {
  reset(); const job = make(); const state = setup(); const replies: string[] = [];
  const client = { async replyStream(_frame: unknown, _id: string, text: string) { replies.push(text); }, async sendMessage() {} } as unknown as WSClient;
  const handler = createMessageHandler(client, options, async () => { throw new Error("must bypass legacy model"); }, undefined, undefined, undefined, state.bridge);
  const frame = { headers: { req_id: "bridge-reply" }, body: { aibotid: options.botId, msgid: "bridge-reply", chattype: "single", from: { userid: "alice-wecom" }, msgtype: "text", text: { content: `补充 ${job.jobId}：三分钟` } } } as MessageFrame;
  handler.handle(frame); handler.handle(frame);
  for (let i = 0; i < 30 && !replies.length; i++) await new Promise(done => setTimeout(done, 10));
  handler.stop();
  assert.equal(state.received.length, 1);
  assert.equal(replies.length, 1);
  assert.match(replies[0], /原任务/);
});
