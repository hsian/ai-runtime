import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WSClient } from "@wecom/aibot-node-sdk";
import type { MessageFrame } from "./client.js";

const directory = mkdtempSync(join(tmpdir(), "wecom-voice-test-"));
process.env.DATABASE_PATH = join(directory, "test.sqlite");
process.env.GIT_ACCESS_TOKEN = "test-only";
process.env.OPERATION_LOG_ENABLED = "false";
process.env.QWECHAT_BOT_ENABLED = "false";
const store = await import("./sessionStore.js");
const { closeDatabase } = await import("../../services/database.js");
const { createMessageHandler } = await import("./messageHandler.js");
const { parseCommand } = await import("./commands.js");
const { createJob, updateJob, getJob } = await import("../../services/jobStore.js");
store.initWecomStore();
after(() => { closeDatabase(); rmSync(directory, { recursive: true, force: true }); });
const options = { botId: "voice-bot", secret: "test", projectId: "b2b-composite", codeAllowedUserIds: ["developer"] };
const delay = () => new Promise(resolve => setTimeout(resolve, 40));
function frame(msgid: string, userid: string, content: unknown, group = false): MessageFrame {
  return { headers: { req_id: msgid }, body: { aibotid: options.botId, msgid, msgtype: "voice",
    chattype: group ? "group" : "single", chatid: group ? "voice-group" : undefined,
    from: { userid }, voice: { content } } } as MessageFrame;
}
function fakeClient() {
  const calls: { id: string; text: string; finish: boolean }[] = [];
  const client = { async replyStream(_frame: unknown, id: string, text: string, finish: boolean) { calls.push({ id, text, finish }); },
    async sendMessage() {} } as unknown as WSClient;
  return { client, calls };
}

test("voice greetings reuse text conversation history, isolate group sessions and deduplicate callbacks", async () => {
  const { client, calls } = fakeClient();
  const handler = createMessageHandler(client, options);
  try {
    const single = frame("greeting", "reader", "你好");
    handler.handle(single); handler.handle(single);
    handler.handle(frame("group-greeting", "reader", "你好", true));
    await delay();
    assert.equal(calls.length, 2);
    assert.ok(calls.every(call => call.finish && call.text.includes("你好") && !call.text.includes("Thinking")));
    for (const target of ["reader", "voice-group"]) {
      const session = store.getSession(options.botId, target, "reader", options.projectId);
      assert.equal(store.getChatHistory(session)[0].content, "你好");
      assert.equal(session.active_job_id, null);
    }
  } finally { handler.stop(); }
});

test("voice transcriptions pass through the existing semantic router and unfinished Thinking stream", async () => {
  const { client, calls } = fakeClient();
  let routed = false;
  const handler = createMessageHandler(client, options, async (command, session) => {
    routed = true;
    assert.equal(command.action, "auto");
    assert.ok("text" in command && command.text === "账套列表标题是什么颜色");
    assert.equal(session.user_id, "semantic-reader");
    return { action: "chat", reply: "已收到语音问题。" };
  });
  try {
    handler.handle(frame("semantic-voice", "semantic-reader", "账套列表标题是什么颜色"));
    await delay();
    assert.equal(routed, true);
    assert.deepEqual(calls.map(call => [call.text, call.finish]), [["Thinking...", false], ["已收到语音问题。", true]]);
    assert.equal(calls[0].id, calls[1].id);
  } finally { handler.stop(); }
});

test("missing, invalid and excessive transcriptions ask for another message without creating jobs", async () => {
  const { client, calls } = fakeClient();
  const handler = createMessageHandler(client, options, async () => { throw new Error("invalid voice must not route"); });
  try {
    for (const [index, value] of [undefined, " ", 123, "x".repeat(50_001)].entries()) handler.handle(frame(`invalid-${index}`, "invalid-reader", value));
    await delay();
    assert.equal(calls.length, 4);
    assert.ok(calls.slice(0, 3).every(call => call.text.includes("没有可用的转写文本")));
    assert.match(calls[3].text, /50000/);
    assert.ok(calls.every(call => call.finish));
  } finally { handler.stop(); }
});

test("spoken control commands are blocked before semantic routing, including transcription punctuation", async () => {
  const { client, calls } = fakeClient();
  const handler = createMessageHandler(client, options, async () => { throw new Error("spoken controls must not route"); });
  try {
    for (const [index, content] of ["执行", "确认执行。", "取消！", "合并", "重试合并", "放弃合并"].entries()) {
      handler.handle(frame(`control-${index}`, "developer", content));
    }
    await delay();
    assert.equal(calls.length, 6);
    assert.ok(calls.every(call => call.finish && call.text.includes("请用文字发送") && !call.text.includes("Thinking")));
  } finally { handler.stop(); }
});

test("semantic voice actions cannot request revert or bypass the text confirmation guard", async () => {
  for (const action of ["execute", "cancel", "merge", "discard", "revert"] as const) {
    const { client, calls } = fakeClient();
    const handler = createMessageHandler(client, options, async () => ({ action }));
    try {
      handler.handle(frame(`resolved-${action}`, "developer", "撤回刚才那次改动"));
      await delay();
      assert.match(calls.at(-1)!.text, /请用文字发送/);
    } finally { handler.stop(); }
  }
});

test("voice change requests still enforce the allowlist, while allowed requests create plans only", async () => {
  const { client, calls } = fakeClient();
  const handler = createMessageHandler(client, options);
  try {
    handler.handle(frame("denied-plan", "plan-reader", "修改：你好"));
    handler.handle(frame("allowed-plan", "developer", "修改：你好"));
    await delay();
    assert.ok(calls.some(call => call.text.includes("只有问答权限")));
    const reader = store.getSession(options.botId, "plan-reader", "plan-reader", options.projectId);
    assert.equal(reader.active_job_id, null);
    const developer = store.getSession(options.botId, "developer", "developer", options.projectId);
    const job = getJob(developer.active_job_id!)!;
    assert.equal(job.requiresConfirm, true);
    assert.equal(job.status, "awaiting_input");
  } finally { handler.stop(); }
});

test("voice follow-up receives existing topic history and cannot execute a pending plan", async () => {
  const { client, calls } = fakeClient();
  const session = store.getSession(options.botId, "followup", "followup", options.projectId);
  store.recordChatExchange(session, "账套标题颜色", "黑色");
  const handler = createMessageHandler(client, options, async (_command, current) => {
    assert.equal(current.conversation_id, session.conversation_id);
    assert.match(JSON.stringify(store.getChatHistory(current)), /黑色/);
    return { action: "chat", reply: "继续当前话题。" };
  });
  const developer = store.getSession(options.botId, "developer", "developer", options.projectId);
  const pending = createJob({ prompt: "标题改蓝", ownerId: developer.owner_id, conversationId: developer.conversation_id });
  updateJob(pending.jobId, { status: "awaiting_confirm", planSummary: "改蓝色" });
  store.bindJob(developer, pending.jobId);
  try {
    handler.handle(frame("followup-voice", "followup", "那字号呢"));
    handler.handle(frame("pending-voice", "developer", "执行。"));
    await delay();
    assert.ok(calls.some(call => call.text === "继续当前话题。"));
    assert.equal(getJob(pending.jobId)?.status, "awaiting_confirm");
    assert.equal(parseCommand("执行").action, "execute");
  } finally { handler.stop(); }
});
