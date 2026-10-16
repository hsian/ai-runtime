import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import type { Job, JobAttachment } from "../../types.js";
import type { JobEventInput } from "../jobEvents.js";
import { createWorkbenchController } from "./controller.js";
import { createWorkbenchWorker, type WorkbenchWorkerDependencies, type WorkbenchRoutingReply } from "./worker.js";
import type { WorkbenchDecision } from "./protocol.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function until(condition: () => boolean) {
  for (let turn = 0; turn < 100; turn++) {
    if (condition()) return;
    await setImmediate();
  }
  assert.fail("worker did not reach the expected state");
}

function setup(patch: Partial<Job> = {}) {
  let job: Job | undefined = {
    jobId: "session", projectId: "project", ownerId: "alice", prompt: "修改登录文案",
    taskMode: "code", workbenchSession: true, status: "awaiting_input", workbenchMessages: [],
    worktreePath: "/isolated/session", branch: "task-branch", workbenchBaseCommitSha: "base",
    createdAt: "2026-10-15", updatedAt: "2026-10-15", ...patch,
  };
  const events: JobEventInput[] = [];
  const kills: string[] = [];
  const executions: string[] = [];
  const deps: WorkbenchWorkerDependencies = {
    get: () => job,
    update: (_id, value) => { if (job) job = { ...job, ...value }; return job; },
    analyze: async () => ({ action: "implement", message: "开始调整文案。", plan: "只调整当前按钮文案" }),
    execute: async id => {
      executions.push(id);
      deps.update(id, { status: "awaiting_merge", commitSha: "code", workbenchExecutionStarted: true, workbenchHasCodeChanges: true, implementationSummary: "已修改并验证。" });
    },
    testCases: async () => undefined,
    event: (_id, phase, text) => { events.push({ type: "stage", phase, text }); },
  };
  const worker = createWorkbenchWorker(deps);
  let onKill = () => {};
  const controller = createWorkbenchController({
    get: deps.get, update: deps.update, worker,
    kill: id => { kills.push(id); onKill(); },
    event: (_id, event) => { events.push(event); },
  });
  return { deps, worker, controller, events, kills, executions, job: () => job!, remove: () => { job = undefined; }, onKill: (handler: () => void) => { onKill = handler; } };
}

test("分析暂停后立即补充并继续，旧方案不执行，新的消息串行处理一次", async () => {
  const state = setup();
  const analysis = deferred<WorkbenchDecision>();
  let rounds = 0;
  state.deps.analyze = async () => ++rounds === 1 ? analysis.promise
    : { action: "implement", message: "按最新补充修改。", plan: "采用最新文案" };
  state.controller.receiveWorkbenchMessage("session", "开始处理");
  await until(() => rounds === 1);
  state.controller.pauseWorkbenchSession("session");
  state.controller.receiveWorkbenchMessage("session", "按钮文案改成登录");
  state.controller.receiveWorkbenchMessage("session", "继续，保持其他逻辑");
  assert.equal(rounds, 1);
  assert.equal(state.job().workbenchPauseRequested, true);
  analysis.resolve({ action: "implement", message: "过期方案", plan: "不能执行的旧方案" });
  await until(() => !state.worker.isRunning("session"));
  assert.equal(rounds, 2);
  assert.deepEqual(state.executions, ["session"]);
  assert.equal(state.job().workbenchProcessedInputs, 3);
  assert.equal(state.job().planSummary, "采用最新文案");
  assert.equal(state.job().workbenchMessages!.some(message => message.text === "过期方案"), false);
  assert.equal(state.job().worktreePath, "/isolated/session");
  assert.equal(state.job().branch, "task-branch");
  assert.equal(state.job().status, "awaiting_merge");
  assert.equal(state.job().workbenchTurnRunning, false);
  assert.deepEqual(state.kills, ["session"]);
});

test("分析中的取消先终止旧轮次，再执行取消控制，不留下执行失败或进入修改", async () => {
  const state = setup();
  const analysis = deferred<WorkbenchDecision>();
  let analyses = 0, cancellations = 0;
  state.deps.analyze = async () => { analyses++; return analysis.promise; };
  state.deps.cancel = async (id, reset) => {
    cancellations++;
    assert.equal(reset, true);
    state.deps.update(id, { status: "awaiting_input", workbenchReset: true, workbenchExecutionStarted: false });
    return "任务已回到未开始。";
  };
  state.onKill(() => analysis.reject(new Error("agent aborted")));
  state.controller.receiveWorkbenchMessage("session", "开始处理");
  await until(() => analyses === 1);
  state.controller.receiveWorkbenchMessage("session", "任务回到未开始");
  await until(() => !state.worker.isRunning("session"));
  assert.equal(analyses, 1);
  assert.equal(cancellations, 1);
  assert.equal(state.job().workbenchProcessedInputs, 2);
  assert.equal(state.job().workbenchReset, true);
  assert.equal(state.job().error, undefined);
  assert.equal(state.job().workbenchPauseRequested, false);
  assert.deepEqual(state.executions, []);
  assert.equal(state.events.some(event => event.phase === "session_error"), false);
});

test("修改中的暂停与快速续接不并发启动两个执行，也不丢弃原工作区", async () => {
  const state = setup();
  const execution = deferred<void>();
  const originalExecute = state.deps.execute;
  let calls = 0, active = 0, maximum = 0;
  state.deps.execute = async id => {
    const current = ++calls;
    active++;
    maximum = Math.max(maximum, active);
    try {
      if (current === 1) await execution.promise;
      else await originalExecute(id);
    } finally { active--; }
  };
  state.controller.receiveWorkbenchMessage("session", "开始修改");
  await until(() => calls === 1);
  state.controller.pauseWorkbenchSession("session");
  state.controller.receiveWorkbenchMessage("session", "继续修改");
  assert.equal(calls, 1);
  execution.resolve(undefined);
  await until(() => !state.worker.isRunning("session"));
  assert.equal(calls, 2);
  assert.equal(maximum, 1);
  assert.equal(state.job().worktreePath, "/isolated/session");
  assert.equal(state.job().status, "awaiting_merge");
  assert.equal(state.job().workbenchProcessedInputs, 2);
});

test("仅分析收到普通补充仍不改代码，明确开始修改才解除分析限制", async () => {
  const state = setup({ workbenchAnalysisOnly: true });
  state.controller.receiveWorkbenchMessage("session", "后端字段已经确认");
  await until(() => !state.worker.isRunning("session"));
  assert.deepEqual(state.executions, []);
  assert.equal(state.job().workbenchAnalysisOnly, true);
  assert.equal(state.job().workbenchExecutionStarted, false);
  state.controller.receiveWorkbenchMessage("session", "请开始修改");
  await until(() => !state.worker.isRunning("session"));
  assert.deepEqual(state.executions, ["session"]);
  assert.equal(state.job().workbenchAnalysisOnly, false);
});

test("合并期间、旧任务运行期间和无效消息不会写入对话或启动模型", () => {
  for (const patch of [{ status: "pending" as const }, { status: "running" as const, workbenchSession: false }]) {
    const state = setup(patch);
    assert.throws(() => state.controller.receiveWorkbenchMessage("session", "继续"), /合并|原任务仍在执行/);
    assert.deepEqual(state.job().workbenchMessages, []);
    assert.equal(state.worker.isRunning("session"), false);
    assert.deepEqual(state.events, []);
  }
  const state = setup();
  for (const text of [" \n ", "x".repeat(20001)]) assert.throws(() => state.controller.receiveWorkbenchMessage("session", text), /消息应为/);
  assert.throws(() => state.controller.pauseWorkbenchSession("session"), /没有正在执行/);
  assert.deepEqual(state.job().workbenchMessages, []);
  assert.deepEqual(state.events, []);
  state.remove();
  assert.throws(() => state.controller.receiveWorkbenchMessage("missing", "继续"), /任务不存在/);
});

test("初次和后续消息的附件索引保留，附件继续绑定各自消息", async () => {
  const initial: JobAttachment = { name: "first.png", path: "/fixtures/first.png", mime: "image/png" };
  const added: JobAttachment = { name: "next.png", path: "/fixtures/next.png", mime: "image/png" };
  const state = setup({ attachments: [initial], workbenchAnalysisOnly: true });
  state.deps.analyze = async () => ({ action: "reply", message: "已读取截图。", plan: "" });
  state.controller.receiveWorkbenchMessage("session", "看下截图");
  await until(() => !state.worker.isRunning("session"));
  state.controller.receiveWorkbenchMessage("session", "  再看这张  ", [added]);
  await until(() => !state.worker.isRunning("session"));
  const inputs = state.job().workbenchMessages!.filter(message => message.role === "user");
  assert.deepEqual(inputs.map(message => message.attachmentIndexes), [[0], [1]]);
  assert.equal(inputs[1].text, "再看这张");
  assert.deepEqual(state.job().attachments, [initial, added]);
  assert.equal(state.events.filter(event => event.type === "user").at(-1)?.attachmentCount, 1);
});

test("闲聊本地回复保留对话，不启动模型或工作区；之后真实请求正常执行", async () => {
  const state = setup({ worktreePath: undefined, branch: undefined });
  let analyses = 0;
  state.deps.analyze = async () => { analyses++; return { action: "implement", message: "开始修改", plan: "修改按钮" }; };
  state.controller.receiveWorkbenchMessage("session", "你好！");
  state.controller.receiveWorkbenchMessage("session", "你能闲聊吗？");
  assert.equal(analyses, 0);
  assert.equal(state.worker.isRunning("session"), false);
  assert.deepEqual(state.executions, []);
  assert.equal(state.job().worktreePath, undefined);
  assert.equal(state.job().status, "awaiting_input");
  assert.equal(state.job().workbenchProcessedInputs, 2);
  assert.equal(state.job().workbenchMessages!.length, 4);
  state.controller.receiveWorkbenchMessage("session", "你好，帮我修改按钮");
  await until(() => !state.worker.isRunning("session"));
  assert.equal(analyses, 1);
  assert.equal(state.job().workbenchProcessedInputs, 3);
  assert.deepEqual(state.executions, ["session"]);
});

test("审查和暂停期间的感谢不改变任务状态、产出或恢复执行", () => {
  for (const patch of [{ status: "awaiting_merge" as const, commitSha: "changed", workbenchHasCodeChanges: true },
    { workbenchPauseRequested: true, workbenchReset: true }]) {
    const state = setup(patch);
    state.deps.analyze = async () => { assert.fail("local reply must not invoke model"); };
    const previous = state.job();
    state.controller.receiveWorkbenchMessage("session", "谢谢");
    assert.equal(state.worker.isRunning("session"), false);
    assert.equal(state.job().status, previous.status);
    assert.equal(state.job().commitSha, previous.commitSha);
    assert.equal(state.job().workbenchPauseRequested, previous.workbenchPauseRequested);
    assert.equal(state.job().workbenchReset, previous.workbenchReset);
    assert.equal(state.job().worktreePath, previous.worktreePath);
  }
});

test("待补充答案及带图片的短消息仍进入原分析流程", async () => {
  const image = { name: "image.png", path: "/fixtures/image.png", mime: "image/png" };
  for (const waiting of [true, false]) {
    const state = setup(waiting ? { workbenchNeedsInput: true, workbenchQuestion: "填写哪个环境名称？" } : {});
    let analyses = 0;
    state.deps.analyze = async () => { analyses++; return { action: "reply", message: "收到补充", plan: "" }; };
    state.controller.receiveWorkbenchMessage("session", "测试", waiting ? [] : [image]);
    await until(() => !state.worker.isRunning("session"));
    assert.equal(analyses, 1);
    assert.equal(state.job().workbenchMessages!.at(-1)!.text, "收到补充");
  }
});

test("语义闲聊不读代码且保留待补充或 Review 状态，后续修改继续原任务", async () => {
  for (const patch of [{ workbenchNeedsInput: true, workbenchQuestion: "选择接口字段", workbenchInputSource: "analysis" as const },
    { status: "awaiting_merge" as const, commitSha: "changed", workbenchHasCodeChanges: true }]) {
    const state = setup(patch); let routed = 0, analyzed = 0;
    state.deps.route = async job => { routed++; assert.equal(job.workbenchQuestion, patch.workbenchQuestion); return { message: "无法联网获取今天新闻。", needsInput: false }; };
    state.deps.analyze = async () => { analyzed++; return { action: "reply", message: "检查完毕", plan: "" }; };
    state.controller.receiveWorkbenchMessage("session", "收集下今天的新闻给我");
    await until(() => !state.worker.isRunning("session"));
    assert.equal(routed, 1); assert.equal(analyzed, 0); assert.deepEqual(state.executions, []);
    assert.equal(state.job().status, patch.status || "awaiting_input");
    assert.equal(state.job().workbenchQuestion, patch.workbenchQuestion);
    assert.equal(state.job().workbenchNeedsInput, patch.workbenchNeedsInput);
    assert.equal(state.job().workbenchMessages!.at(-1)!.text, "无法联网获取今天新闻。");
    state.deps.route = async () => undefined;
    state.controller.receiveWorkbenchMessage("session", "检查登录接口字段");
    await until(() => !state.worker.isRunning("session"));
    assert.equal(analyzed, 1); assert.equal(state.job().workbenchProcessedInputs, 2);
  }
});

test("分流中收到新要求，旧消息不会触发代码分析；暂停也不会进入分析", async () => {
  const state = setup(); const routing = deferred<WorkbenchRoutingReply | undefined>(); let routes = 0, analyses = 0;
  state.deps.route = async () => ++routes === 1 ? routing.promise : { message: "先讨论，不修改。", needsInput: false };
  state.deps.analyze = async () => { analyses++; return { action: "reply", message: "旧分析", plan: "" }; };
  state.controller.receiveWorkbenchMessage("session", "修改按钮"); await until(() => routes === 1);
  assert.equal(state.job().status, "planning", "routing must remain visible and stoppable");
  state.controller.receiveWorkbenchMessage("session", "先别修改，我们聊聊"); routing.resolve(undefined);
  await until(() => !state.worker.isRunning("session"));
  assert.equal(routes, 2); assert.equal(analyses, 0); assert.deepEqual(state.executions, []);
  assert.equal(state.job().status, "awaiting_input", "finished chat must restore the original task state");
  const paused = setup(); const slow = deferred<WorkbenchRoutingReply | undefined>(); let started = false;
  paused.deps.route = async () => { started = true; return slow.promise; };
  paused.deps.analyze = async () => assert.fail("paused routing must not analyze code");
  paused.controller.receiveWorkbenchMessage("session", "检查代码"); await until(() => started);
  paused.controller.pauseWorkbenchSession("session"); slow.resolve(undefined);
  await until(() => !paused.worker.isRunning("session"));
  assert.equal(paused.job().workbenchPauseRequested, true);
});

test("语义不明确时直接提出补充问题，不加载代码分析或执行", async () => {
  const state = setup();
  state.deps.route = async () => ({ message: "你指的是哪个页面？", needsInput: true });
  state.deps.analyze = async () => assert.fail("uncertain routing must ask first");
  state.controller.receiveWorkbenchMessage("session", "处理一下那个");
  await until(() => !state.worker.isRunning("session"));
  assert.equal(state.job().status, "awaiting_input");
  assert.equal(state.job().workbenchNeedsInput, true);
  assert.equal(state.job().workbenchQuestion, "你指的是哪个页面？");
  assert.equal(state.job().workbenchInputSource, "analysis");
  assert.deepEqual(state.executions, []);
});
