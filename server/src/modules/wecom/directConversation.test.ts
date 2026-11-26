import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { EventType, type EventMessage, type TemplateCard, type WSClient } from "@wecom/aibot-node-sdk";
import type { MessageFrame } from "./client.js";

const directory = mkdtempSync(join(tmpdir(), "wecom-direct-"));
process.env.DATABASE_PATH = join(directory, "test.sqlite");
process.env.GIT_ACCESS_TOKEN = "test-only";
process.env.OPERATION_LOG_ENABLED = "false";
const store = await import("./sessionStore.js");
const { closeDatabase } = await import("../../services/database.js");
const { createJob, getJob, updateJob } = await import("../../services/jobStore.js");
const { getProject } = await import("../../services/projectRegistry.js");
const { parseConversationAnswer, ProjectReadPreparationError, runDirectConversation } = await import("./directConversation.js");
const { createDirectMessageHandler } = await import("./directMessageHandler.js");
const { createConversationActions } = await import("./conversationActions.js");
const { ResponseCoordinator } = await import("./responseCoordinator.js");
const options = { botId: "direct-test", secret: "test", projectId: "b2b-composite", codeAllowedUserIds: ["alice"] };
const prepareFixtureRepository = async (id: string) => {
  assert.equal(id, options.projectId);
  return getProject(id).workspaceDir;
};
store.initWecomStore();
after(() => { closeDatabase(); rmSync(directory, { recursive: true, force: true }); });

function callback(taskId: string, sender = "alice", target = "alice", key = "confirm"): EventMessage {
  return { aibotid: options.botId, msgid: "click", create_time: 0, chattype: target === sender ? "single" : "group",
    chatid: target, from: { userid: sender }, msgtype: "event",
    event: { eventtype: EventType.TemplateCardEvent, task_id: taskId, event_key: `${key}_${taskId}` } };
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
  const result = await runDirectConversation(session, options.projectId, "改好没？", [],
    async (cwd, input, _context, _event, request) => {
      calls++;
      assert.equal(cwd, getProject(options.projectId).workspaceDir);
      assert.equal(request?.mode, "conversation");
      assert.equal(request?.conversationRepoTools, true);
      assert.equal(request?.jsonSchema, undefined);
      assert.match(input, /方案待确认，还未开始修改/);
      assert.match(input, /前一句/);
      assert.doesNotMatch(input, /不能泄露的任务|不要复述这份长方案/);
      return { summary: "还没改，方案在等确认。" };
    }, prepareFixtureRepository);
  assert.equal(calls, 1);
  assert.deepEqual(result, { text: "还没改，方案在等确认。" });
});

test("the same work-only policy sees the latest message and context in one agent call", async () => {
  const session = store.getSession(options.botId, "scope-group", "alice", options.projectId);
  store.recordChatExchange(session, "合同变更执行失败了。", "这个任务上次没执行完。");
  for (const message of ["你好，帮我看看合同变更", "再试下", "讲个笑话"]) {
    let calls = 0;
    await runDirectConversation(session, options.projectId, message, [], async (_cwd, input, _context, _event, request) => {
      calls++;
      assert.equal(JSON.parse(input).message, message);
      assert.match(input, /合同变更执行失败/);
      assert.match(request!.systemPrompt!, /只处理工作相关请求.*不按关键词拦截/);
      assert.match(request!.systemPrompt!, /招呼里带着工作请求就直接处理/);
      assert.match(request!.systemPrompt!, /简短追问先联系工作上文/);
      assert.match(request!.systemPrompt!, /明确无关.*不用工具查找.*不附加操作提议/);
      return { summary: "测试回复" };
    }, prepareFixtureRepository);
    assert.equal(calls, 1);
  }
});

test("repository preparation failures do not query an empty directory or invoke the agent", async () => {
  const session = store.getSession(options.botId, "no-checkout", "alice", options.projectId);
  await assert.rejects(runDirectConversation(session, options.projectId, "列表字是什么颜色？", [],
    async () => assert.fail("must not invoke the agent"),
    async () => { throw new Error("checkout failed"); }), ProjectReadPreparationError);
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

test("a slow reply sends one progress message and replaces it in the same stream", { timeout: 5000 }, async () => {
  const replies: { id: string; text: string; finish: boolean }[] = [];
  let finishConversation!: () => void;
  const waiting = new Promise<void>(resolve => { finishConversation = resolve; });
  let finishReply!: () => void;
  const completed = new Promise<void>(resolve => { finishReply = resolve; });
  const fake = { async replyStream(_frame: unknown, id: string, text: string, finish: boolean) {
    replies.push({ id, text, finish });
    if (finish) finishReply();
    else finishConversation();
  } } as unknown as WSClient;
  const handler = createDirectMessageHandler(fake, options, undefined, async () => {
    await waiting;
    return { text: "最终回复" };
  });
  try {
    handler.handle({ headers: { req_id: "slow-progress" }, body: { aibotid: options.botId, msgid: "slow-progress",
      chattype: "single", from: { userid: "alice" }, msgtype: "text", text: { content: "查一下合同变更" } } } as MessageFrame);
    await completed;
    assert.equal(replies.length, 2);
    assert.equal(replies[0].finish, false);
    assert.ok(replies[0].text.trim());
    assert.notEqual(replies[0].text, "最终回复");
    assert.deepEqual(replies[1], { id: replies[0].id, text: "最终回复", finish: true });
  } finally {
    handler.stop();
    finishConversation();
  }
});

test("execution keeps the proposal above the card and uses a separate progress stream", { timeout: 3000 }, async () => {
  let cardSent!: (card: TemplateCard) => void;
  const sent = new Promise<TemplateCard>(resolve => { cardSent = resolve; });
  let finishProposal!: () => void;
  const proposalFinished = new Promise<void>(resolve => { finishProposal = resolve; });
  const executed: string[] = [];
  const sentParts: string[] = [];
  const streamIds: string[] = [];
  const fake = {
    async replyStream(frame: MessageFrame, stream: string, text: string, finish: boolean) {
      assert.equal(frame.headers.req_id, "card-reply");
      streamIds.push(stream);
      if (text.includes("待确认的修改范围")) {
        sentParts.push(finish ? "scope-final" : "scope");
        if (finish) finishProposal();
      } else if (finish) {
        assert.match(text, /改好了/);
        sentParts.push("final");
      } else {
        assert.equal(text, "已确认执行。");
        sentParts.push("execution");
      }
    },
    async replyTemplateCard(frame: MessageFrame, card: TemplateCard) {
      assert.equal(frame.headers.req_id, "card-reply");
      assert.deepEqual(sentParts, ["scope"]);
      sentParts.push("card");
      cardSent(card);
    },
    async sendMessage() { assert.fail("must not send an unsolicited card"); },
    async updateTemplateCard() { assert.fail("execution must not reply using the click callback"); },
  } as unknown as WSClient;
  const responses = new ResponseCoordinator(fake);
  const actions = createConversationActions(options, {
    executePlannedJob(jobId) { executed.push(jobId); },
    requestTaskMerge() { assert.fail("must not merge"); },
  });
  const handler = createDirectMessageHandler(fake, options, responses,
    async () => ({ text: "可以改。", proposal: { action: "change", plan: "只改账套列表文字颜色" } }), actions);
  try {
    handler.handle({ headers: { req_id: "card-reply" }, body: { aibotid: options.botId, msgid: "card-reply",
      chattype: "single", from: { userid: "alice" }, msgtype: "text", text: { content: "改一下账套标题颜色" } } } as MessageFrame);
    const card = await sent;
    await proposalFinished;
    assert.deepEqual(sentParts, ["scope", "card", "scope-final"]);
    assert.deepEqual(executed, []);
    assert.deepEqual(card.button_list?.map(button => button.text), ["确认执行", "取消"]);
    const body = {
      ...callback(card.task_id!),
      event: {
        eventtype: EventType.TemplateCardEvent as const,
        template_card_event: {
          card_type: "button_interaction",
          event_key: card.button_list![0].key,
          task_id: card.task_id,
        },
      },
    };
    const frame = { headers: { req_id: "card-click" }, body };
    handler.handleConfirmation(frame);
    handler.handleConfirmation(frame);
    assert.equal(executed.length, 1);
    assert.equal(await responses.finish(executed[0], "改好了"), true);
    assert.deepEqual(sentParts, ["scope", "card", "scope-final", "execution", "final"]);
    assert.equal(streamIds[0], streamIds[1]);
    assert.equal(streamIds[2], streamIds[3]);
    assert.notEqual(streamIds[0], streamIds[2]);
  } finally { handler.stop(); responses.stop(); }
});

test("only the requester can cancel a confirmation and neither button can be used again", () => {
  const session = store.getSession(options.botId, "cancel-card-group", "alice", options.projectId);
  const actions = createConversationActions(options, {
    executePlannedJob() { assert.fail("cancel must not execute"); },
    requestTaskMerge() { assert.fail("cancel must not merge"); },
  });
  const count = store.listBindings().length;
  const execution = actions.offer(session, options.projectId, { action: "change", plan: "改字色" });
  const executionCardId = execution.card!.task_id!;
  const reasons: string[] = [];
  const ignored = (reason: string) => { reasons.push(reason); };
  assert.equal(actions.confirm(callback(executionCardId, "bob", "cancel-card-group", "cancel"), ignored), undefined);
  assert.equal(actions.confirm(callback(executionCardId, "alice", "other-group", "cancel"), ignored), undefined);
  assert.deepEqual(reasons, ["sender_mismatch", "chat_mismatch"]);
  const nestedCancelEvent = {
    ...callback(executionCardId, "alice", "cancel-card-group"),
    event: {
      eventtype: EventType.TemplateCardEvent as const,
      template_card_event: { event_key: execution.card!.button_list![1].key, task_id: executionCardId },
    },
  };
  const conflictingEvent = { ...nestedCancelEvent, event: { ...nestedCancelEvent.event, event_key: execution.card!.button_list![0].key } };
  assert.equal(actions.confirm(conflictingEvent, ignored), undefined);
  assert.equal(reasons.at(-1), "conflicting_card_payload");
  assert.match(actions.confirm(nestedCancelEvent)!, /没有开始执行/);
  assert.equal(actions.confirm(callback(executionCardId, "alice", "cancel-card-group")), undefined);
  assert.equal(store.listBindings().length, count);

  const job = createJob({ prompt: "合同变更", ownerId: session.owner_id, projectId: options.projectId, taskMode: "code" });
  store.bindJob(session, job.jobId);
  updateJob(job.jobId, { status: "awaiting_merge", branch: "feature", sourceCommitSha: "a".repeat(40) });
  const merge = actions.offer(session, options.projectId, { action: "merge", jobId: job.jobId });
  assert.deepEqual(merge.card!.button_list?.map(button => button.text), ["确认合并", "取消"]);
  const mergeCardId = merge.card!.task_id!;
  assert.match(actions.confirm(callback(mergeCardId, "alice", "cancel-card-group", "cancel"))!, /没有开始合并/);
  assert.equal(actions.confirm(callback(mergeCardId, "alice", "cancel-card-group")), undefined);
  assert.equal(getJob(job.jobId)?.status, "awaiting_merge");
});

test("a proposal starts only after a scoped, single-use click and follows project auto-merge settings", () => {
  const session = store.getSession(options.botId, "alice", "alice", options.projectId);
  const executed: string[] = [];
  const actions = createConversationActions(options, {
    executePlannedJob(jobId, ownerId) {
      const job = getJob(jobId)!;
      assert.equal(job.ownerId, ownerId);
      assert.equal(job.requireMergeConfirmation, false);
      assert.equal(job.conversationHistory, undefined);
      executed.push(jobId);
    },
    requestTaskMerge() { assert.fail("the execution worker handles automatic merging after modification"); },
  });
  const parsed = parseConversationAnswer('我准备改这里。\nXIAODI_PROPOSAL {"action":"change","plan":"只改合同变更页并验证两种合同类型"}');
  assert.equal(parsed.text, "我准备改这里。");
  const offer = actions.offer(session, options.projectId, parsed.proposal!);
  assert.match(offer.text, /只改合同变更页/);
  assert.match(offer.text, /自动合并到 `test`/);
  assert.equal(executed.length, 0);
  const cardId = offer.card!.task_id!;
  const rewritten = callback(cardId);
  if (rewritten.event.eventtype === EventType.TemplateCardEvent) rewritten.event.task_id = "platform-card-id";
  assert.equal(actions.confirm(callback(cardId, "bob", "alice")), undefined);
  assert.equal(actions.confirm(callback(cardId, "alice", "other-group")), undefined);
  assert.equal(actions.confirm(rewritten), "已确认执行。");
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
