import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WSClient } from "@wecom/aibot-node-sdk";
import type { MessageFrame } from "./client.js";
import type { Command } from "./commands.js";

const directory = mkdtempSync(join(tmpdir(), "wecom-permissions-test-"));
process.env.DATABASE_PATH = join(directory, "test.sqlite");
process.env.GIT_ACCESS_TOKEN = "test-only";
process.env.OPERATION_LOG_ENABLED = "false";
process.env.QWECHAT_BOT_ENABLED = "false";
const store = await import("./sessionStore.js");
const { closeDatabase } = await import("../../services/database.js");
const { createJob, updateJob, getJob } = await import("../../services/jobStore.js");
const { getDialogue, setDialogue } = await import("./dialogueStore.js");
const { dispatchCommand } = await import("./jobBridge.js");
const { createMessageHandler } = await import("./messageHandler.js");
const { parseCodeAllowedUserIds } = await import("./config.js");
const { canModifyCode, requireCommandPermission, CODE_PERMISSION_DENIED } = await import("./permissions.js");
store.initWecomStore();
after(() => { closeDatabase(); rmSync(directory, { recursive: true, force: true }); });
const allowedId = "woSnTTDwAA1cPV35MQB6a71gjxZeC6NQ";
const options = { botId: "permissions", secret: "test", projectId: "b2b-composite", codeAllowedUserIds: [allowedId] };

test("allowlist parsing deduplicates IDs, rejects wildcards and denies missing or empty configuration", () => {
  assert.deepEqual(parseCodeAllowedUserIds(` ${allowedId}, reader，${allowedId}\nother `), [allowedId, "reader", "other"]);
  assert.deepEqual(parseCodeAllowedUserIds(" , ， "), []);
  assert.throws(() => parseCodeAllowedUserIds("*"), /不支持通配符/);
  assert.equal(canModifyCode(options, allowedId), true);
  assert.equal(canModifyCode(options, "reader"), false);
  assert.equal(canModifyCode({ ...options, codeAllowedUserIds: [] }, allowedId), false);
  assert.equal(canModifyCode({ botId: "bot", secret: "test", projectId: "b2b-composite" }, allowedId), false);
});

test("all write commands are denied before any topic or job mutation for a read-only member", async () => {
  const session = store.getSession(options.botId, "reader", "reader", options.projectId);
  const original = { ...session };
  const commands: Command[] = [
    { action: "plan", text: "改成蓝色", topicId: "new" }, { action: "clarify", text: "蓝色" },
    { action: "execute" }, { action: "merge" }, { action: "discard" }, { action: "revert" },
  ];
  for (const [index, command] of commands.entries()) {
    await assert.rejects(dispatchCommand(session, command, `deny-${index}`, options), error => error instanceof Error && error.message === CODE_PERMISSION_DENIED);
  }
  assert.deepEqual(session, original);
  assert.equal(store.listBindings().filter(binding => binding.session_key === session.session_key).length, 0);
  for (const command of [{ action: "question", text: "颜色是什么" }, { action: "chat", reply: "你好" },
    { action: "status" }, { action: "identity" }, { action: "help" }] as Command[]) {
    assert.doesNotThrow(() => requireCommandPermission(session, command, options));
  }
  assert.match(await dispatchCommand(session, { action: "identity" }, "reader-id", options), /当前权限：仅问答/);
});

test("removed developers cannot execute old plans, cancel code jobs or confirm pending revert", async () => {
  const session = store.getSession(options.botId, allowedId, allowedId, options.projectId);
  const job = createJob({ prompt: "改标题", ownerId: session.owner_id, conversationId: session.conversation_id, taskMode: "code" });
  updateJob(job.jobId, { status: "awaiting_confirm", planSummary: "改为蓝色" });
  store.bindJob(session, job.jobId);
  const removed = { ...options, codeAllowedUserIds: [] };
  await assert.rejects(dispatchCommand(session, { action: "execute", jobId: job.jobId }, "removed-execute", removed), /只有问答权限/);
  await assert.rejects(dispatchCommand(session, { action: "cancel", jobId: job.jobId }, "removed-cancel", removed), /只有问答权限/);
  setDialogue(session, { step: "revert_confirm", sourceJobId: job.jobId });
  await assert.rejects(dispatchCommand(session, { action: "cancel" }, "removed-revert-cancel", removed), /只有问答权限/);
  assert.equal(getDialogue(session)?.step, "revert_confirm");
  assert.equal(getJob(job.jobId)?.status, "awaiting_confirm");
  assert.match(await dispatchCommand(session, { action: "identity" }, "developer-id", options), /当前权限：问答和修改代码/);
});

test("read-only members can inspect and cancel their own read-only questions", async () => {
  const session = store.getSession(options.botId, "question-reader", "question-reader", options.projectId);
  const job = createJob({ prompt: "标题颜色", ownerId: session.owner_id, conversationId: session.conversation_id, taskMode: "question" });
  updateJob(job.jobId, { status: "pending" });
  store.bindJob(session, job.jobId);
  assert.match(await dispatchCommand(session, { action: "status", jobId: job.jobId }, "reader-status", options), /处理中/);
  assert.match(await dispatchCommand(session, { action: "cancel", jobId: job.jobId }, "reader-cancel", options), /已取消/);
  assert.equal(getJob(job.jobId)?.status, "cancelled");
});

test("natural-language modifications are rejected with the permission message rather than a plan or question task", async () => {
  const calls: string[] = [];
  const client = { async replyStream(_frame: unknown, _id: string, text: string) { calls.push(text); }, async sendMessage() {} } as unknown as WSClient;
  const handler = createMessageHandler(client, options, async () => ({ action: "plan", text: "账套标题改蓝", topicId: "new" }));
  try {
    handler.handle({ headers: { req_id: "denied-natural" }, body: { aibotid: options.botId, msgid: "denied-natural",
      chattype: "single", from: { userid: "natural-reader" }, msgtype: "text", text: { content: "帮我把账套标题改蓝" } } } as MessageFrame);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(calls.at(-1), CODE_PERMISSION_DENIED);
    const session = store.getSession(options.botId, "natural-reader", "natural-reader", options.projectId);
    assert.equal(session.active_job_id, null);
    assert.equal(store.listBindings().filter(binding => binding.session_key === session.session_key).length, 0);
  } finally { handler.stop(); }
});

test("being allowlisted does not grant access to another member's task", async () => {
  const developer = store.getSession(options.botId, "dev-owner-test", allowedId, options.projectId);
  const other = store.getSession(options.botId, "other-owner-test", "other", options.projectId);
  const job = createJob({ prompt: "其他人的计划", ownerId: other.owner_id, conversationId: other.conversation_id });
  updateJob(job.jobId, { status: "awaiting_confirm", planSummary: "计划" });
  store.bindJob(other, job.jobId);
  await assert.rejects(dispatchCommand(developer, { action: "execute", jobId: job.jobId }, "cross-owner", options), /没有这个任务/);
  assert.equal(getJob(job.jobId)?.status, "awaiting_confirm");
});
