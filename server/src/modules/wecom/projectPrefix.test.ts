import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { WSClient } from "@wecom/aibot-node-sdk";
import type { MessageFrame } from "./client.js";
import type { Command } from "./commands.js";

const directory = mkdtempSync(join(tmpdir(), "wecom-project-prefix-"));
process.env.DATABASE_PATH = join(directory, "test.sqlite");
process.env.UPLOAD_DIR = join(directory, "uploads");
process.env.GIT_ACCESS_TOKEN = "test-only";
process.env.OPERATION_LOG_ENABLED = "false";
process.env.QWECHAT_BOT_ENABLED = "false";
process.env.CLIENT_COOKIE_SECRET = "project-prefix-test-secret";
process.env.AGENT_PROVIDER = "claude";
const { parseCommand } = await import("./commands.js");
const { prepareTapdMessage } = await import("./tapdBridge.js");
const { resolveIntent } = await import("./intentRouter.js");
const { dispatchCommand } = await import("./jobBridge.js");
const { createMessageHandler } = await import("./messageHandler.js");
const store = await import("./sessionStore.js");
const { createJob, updateJob, getJob } = await import("../../services/jobStore.js");
const { closeDatabase } = await import("../../services/database.js");
store.initWecomStore();
after(() => { closeDatabase(); rmSync(directory, { recursive: true, force: true }); });
const mini = "yuenongjiao-mini";
const options = { botId: "project-prefix", secret: "test", projectId: "b2b-composite", codeAllowedUserIds: ["alice"] };

test("project and engine prefixes combine in either order and do not match embedded text", () => {
  for (const prefix of ["#codex #小程序", "#小程序 #codex"]) {
    assert.deepEqual(parseCommand(`${prefix} 问答：登录逻辑`),
      { action: "question", text: "登录逻辑", agentProvider: "codex", projectId: mini });
  }
  assert.deepEqual(parseCommand("#小程序 状态"), { action: "status", jobId: undefined, projectId: mini });
  assert.deepEqual(parseCommand("#小程序：执行"), { action: "execute", jobId: undefined, projectId: mini });
  assert.equal(parseCommand("#小程序").action, "chat");
  assert.equal(parseCommand("解释 #小程序 标识").projectId, undefined);
  assert.equal(parseCommand("#小程序员 问题").projectId, undefined);
});

test("mini-program tasks use the selected project and retain their task engine", async () => {
  const selected = { ...options, projectId: mini };
  const session = store.getSession(options.botId, "jobs", "alice", mini);
  const stopBeforeAgent = new Error("Stop before external agent");
  for (const task of ["问答", "修改", "测试用例"]) {
    let jobId = "";
    await assert.rejects(dispatchCommand(session, parseCommand(`#小程序 #codex ${task}：登录`), `${task}-mini`, selected,
      id => { jobId = id; throw stopBeforeAgent; }), error => error === stopBeforeAgent);
    const job = getJob(jobId)!;
    assert.equal(job.projectId, mini);
    assert.equal(job.agentProvider, "codex");
    assert.equal(job.prompt, "登录");
    updateJob(jobId, { status: "completed" });
  }
});

test("combined prefixes survive TAPD preparation and semantic routing", async () => {
  const session = store.getSession(options.botId, "tapd", "alice", mini);
  const url = "https://www.tapd.cn/123/stories/view/456";
  const prepared = await prepareTapdMessage(session, `#小程序 #codex ${url} 生成用例`, async () => ({
    snapshotId: randomUUID(), context: { url, workspaceId: "123", itemType: "story", itemId: "456",
      title: "Mini login", description: "Mini validation", commentCount: 0, fetchedAt: new Date().toISOString() },
    attachments: [], warnings: [],
  }));
  const command = await resolveIntent(prepared.command, session, async input => {
    assert.equal(JSON.parse(input).message, "生成用例");
    return JSON.stringify({ intent: "test-case", prompt: "Mini login cases", reply: "", topicId: prepared.topicId });
  });
  assert.equal(command.projectId, mini);
  assert.equal(command.agentProvider, "codex");
  assert.equal(command.topicId, session.conversation_id);
});

test("message routing isolates project history and locates numbered tasks only in the bound chat", { timeout: 10_000 }, async () => {
  const seen: { command: Command; project: string; history: string }[] = [];
  let finish: (() => void) | undefined;
  const client = { async replyStream(_frame: unknown, _id: string, _text: string, done: boolean) {
    if (done) finish?.();
  }, async sendMessage() {} } as unknown as WSClient;
  const handler = createMessageHandler(client, options, async (command, session) => {
    const project = JSON.parse(session.session_key)[3] as string;
    seen.push({ command, project, history: JSON.stringify(store.getChatHistory(session)) });
    return { action: "chat", reply: "Received" };
  });
  async function send(text: string, user = "alice", chatid = "group") {
    const completed = new Promise<void>(resolve => { finish = resolve; });
    handler.handle({ headers: { req_id: randomUUID() }, body: { aibotid: options.botId, msgid: randomUUID(),
      msgtype: "text", chattype: "group", chatid, from: { userid: user }, text: { content: text } } } as MessageFrame);
    await completed;
  }
  try {
    await send("问答：composite-only-context");
    await send("#小程序 问答：mini-only-context");
    await send("#codex #小程序 问答：组合测试");
    await send("问答：默认项目追问");
    assert.deepEqual(seen.map(item => item.project), [options.projectId, mini, mini, options.projectId]);
    assert.doesNotMatch(seen[1].history, /composite-only-context/);
    assert.match(seen[2].history, /mini-only-context/);
    assert.doesNotMatch(seen[3].history, /mini-only-context/);
    assert.equal(seen[2].command.agentProvider, "codex");
    assert.equal(seen[3].command.agentProvider, undefined);
    const session = store.getSession(options.botId, "group", "alice", mini);
    const job = createJob({ prompt: "Mini task", projectId: mini, ownerId: session.owner_id,
      conversationId: session.conversation_id, taskMode: "question" });
    store.bindJob(session, job.jobId);
    await send(`#小程序 状态`);
    assert.equal(seen.at(-1)!.project, mini);
    await send(`状态 ${job.jobId}`);
    assert.equal(seen.at(-1)!.project, mini);
    await send(`状态 ${job.jobId}`, "bob");
    assert.equal(seen.at(-1)!.project, options.projectId);
    await send(`状态 ${job.jobId}`, "alice", "other-group");
    assert.equal(seen.at(-1)!.project, options.projectId);
  } finally { handler.stop(); }
});
