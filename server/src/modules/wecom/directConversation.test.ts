import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { EventType, type EventMessage, type WSClient } from "@wecom/aibot-node-sdk";
import type { MessageFrame } from "./client.js";

const directory = mkdtempSync(join(tmpdir(), "wecom-direct-"));
process.env.DATABASE_PATH = join(directory, "test.sqlite");
process.env.GIT_ACCESS_TOKEN = "test-only";
process.env.OPERATION_LOG_ENABLED = "false";
const store = await import("./sessionStore.js");
const { closeDatabase } = await import("../../services/database.js");
const { createJob, getJob, updateJob } = await import("../../services/jobStore.js");
const { getProject } = await import("../../services/projectRegistry.js");
const { parseConversationAnswer, runDirectConversation } = await import("./directConversation.js");
const { createDirectMessageHandler } = await import("./directMessageHandler.js");
const { createConversationActions } = await import("./conversationActions.js");
const options = { botId: "direct-test", secret: "test", projectId: "b2b-composite", codeAllowedUserIds: ["alice"] };
store.initWecomStore();
after(() => { closeDatabase(); rmSync(directory, { recursive: true, force: true }); });

function callback(taskId: string, sender = "alice", target = "alice"): EventMessage {
  return { aibotid: options.botId, msgid: "click", create_time: 0, chattype: target === sender ? "single" : "group",
    chatid: target, from: { userid: sender }, msgtype: "event",
    event: { eventtype: EventType.TemplateCardEvent, task_id: taskId, event_key: "confirm" } };
}

test("the conversation calls one read-only agent with concise, owned task facts", async () => {
  const session = store.getSession(options.botId, "direct-group", "alice", options.projectId);
  const own = createJob({ prompt: "合同变更", ownerId: session.owner_id, projectId: options.projectId, taskMode: "code" });
  const foreign = createJob({ prompt: "不能泄露的任务", ownerId: "someone-else", projectId: options.projectId, taskMode: "code" });
  store.bindJob(session, own.jobId);
  store.bindJob(session, foreign.jobId, false);
  updateJob(own.jobId, { status: "awaiting_confirm", planSummary: "不要复述这份长方案" });
  store.recordChatExchange(session, "前一句", "上轮回复");
  let calls = 0;
  const result = await runDirectConversation(session, options.projectId, "改好没？", [], undefined,
    async (_cwd, input, _context, _event, request) => {
      calls++;
      assert.equal(request?.mode, "conversation");
      assert.equal(request?.jsonSchema, undefined);
      assert.match(input, /方案待确认，还未开始修改/);
      assert.match(input, /前一句/);
      assert.doesNotMatch(input, /不能泄露的任务|不要复述这份长方案/);
      return { summary: "还没改，方案在等确认。" };
    });
  assert.equal(calls, 1);
  assert.deepEqual(result, { text: "还没改，方案在等确认。" });
});

test("ordinary messages are forwarded verbatim once, including former command strings", { timeout: 3000 }, async () => {
  const replied: string[] = [];
  const inputs: string[] = [];
  let resolveReplies!: () => void;
  const completed = new Promise<void>(resolve => { resolveReplies = resolve; });
  const fake = { async replyStream(_frame: unknown, _stream: string, text: string, finish: boolean) {
    if (finish) replied.push(text);
    if (replied.length === 2) resolveReplies();
  } } as unknown as WSClient;
  const handler = createDirectMessageHandler(fake, options, undefined, async (_session, _project, input) => {
    inputs.push(input);
    return { text: "Codex 原文" };
  });
  try {
    for (const [msgid, content] of [["hello", "你好"], ["former", "/help"]]) {
      const frame = { headers: { req_id: msgid }, body: { aibotid: options.botId, msgid, chattype: "single",
        from: { userid: "alice" }, msgtype: "text", text: { content } } } as MessageFrame;
      handler.handle(frame);
      handler.handle(frame);
    }
    await completed;
    assert.deepEqual(inputs, ["你好", "/help"]);
    assert.deepEqual(replied, ["Codex 原文", "Codex 原文"]);
  } finally { handler.stop(); }
});

test("a proposal requires a scoped, single-use button click and execution does not approve merging", () => {
  const session = store.getSession(options.botId, "alice", "alice", options.projectId);
  const executed: string[] = [];
  const actions = createConversationActions(options, {
    executePlannedJob(jobId, ownerId) {
      const job = getJob(jobId)!;
      assert.equal(job.ownerId, ownerId);
      assert.equal(job.requireMergeConfirmation, true);
      executed.push(jobId);
    },
    requestTaskMerge() { assert.fail("must not merge on execution approval"); },
  });
  const parsed = parseConversationAnswer('我准备改这里。\nXIAODI_PROPOSAL {"action":"change","plan":"只改合同变更页并验证两种合同类型"}');
  assert.equal(parsed.text, "我准备改这里。");
  const offer = actions.offer(session, options.projectId, parsed.proposal!);
  assert.match(offer.text, /只改合同变更页/);
  assert.equal(executed.length, 0);
  const cardId = offer.card!.task_id!;
  assert.equal(actions.confirm(callback(cardId, "bob", "alice")), undefined);
  assert.equal(actions.confirm(callback(cardId, "alice", "other-group")), undefined);
  assert.match(actions.confirm(callback(cardId))!, /已确认执行/);
  assert.equal(actions.confirm(callback(cardId)), undefined);
  assert.equal(executed.length, 1);
});

test("merge approval expires, is bound to the exact version, and requires an allowlisted owner", () => {
  const session = store.getSession(options.botId, "alice", "alice", options.projectId);
  const job = createJob({ prompt: "合同变更", ownerId: session.owner_id, projectId: options.projectId, taskMode: "code" });
  const firstCommit = "a".repeat(40);
  const secondCommit = "b".repeat(40);
  store.bindJob(session, job.jobId);
  updateJob(job.jobId, { status: "awaiting_merge", branch: "feature", sourceCommitSha: firstCommit });
  let now = 0;
  const merges: unknown[] = [];
  const actions = createConversationActions(options, {
    executePlannedJob() { assert.fail("must not execute on merge approval"); },
    requestTaskMerge(id, input) { merges.push({ id, ...input }); return 0; },
  }, () => now);
  const proposal = { action: "merge", jobId: job.jobId } as const;
  const foreign = store.getSession(options.botId, "bob", "bob", options.projectId);
  assert.equal(actions.offer(foreign, options.projectId, proposal).card, undefined);
  const expired = actions.offer(session, options.projectId, proposal).card!.task_id!;
  now += 10 * 60_000;
  assert.match(actions.confirm(callback(expired))!, /已过期/);
  const stale = actions.offer(session, options.projectId, proposal).card!.task_id!;
  updateJob(job.jobId, { sourceCommitSha: secondCommit });
  assert.match(actions.confirm(callback(stale))!, /已变化/);
  assert.deepEqual(merges, []);
  const current = actions.offer(session, options.projectId, proposal).card!.task_id!;
  assert.match(actions.confirm(callback(current))!, /已确认合并/);
  assert.deepEqual(merges, [{ id: job.jobId,
    confirmedVersion: { commit: secondCommit, targetBranch: getProject(options.projectId).defaultBranch } }]);
});
