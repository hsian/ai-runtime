import assert from "node:assert/strict";
import test from "node:test";
import { createWorkbenchWorker, parseWorkbenchDecision, isWorkbenchCancellation, isWorkbenchResetRequest, type WorkbenchWorkerDependencies } from "./workbenchSession.js";
import type { Job } from "../types.js";

const setup = () => {
  let job: Job = { jobId: "session-1", projectId: "b2b-composite", ownerId: "alice", conversationId: "task-1", taskMode: "code", workbenchSession: true, status: "awaiting_input", prompt: "实现短信登录", worktreePath: "/isolated/task-1", createdAt: "2026-10-13", updatedAt: "2026-10-13", workbenchMessages: [{ id: "input-1", role: "user", text: "开始处理", createdAt: "2026-10-13" }] };
  const executions: string[] = [];
  const deps: WorkbenchWorkerDependencies = {
    get: () => job,
    update: (_, patch) => { job = { ...job, ...patch }; return job; },
    event: () => undefined,
    analyze: async () => ({ action: "implement", message: "我会先检查登录组件，然后增加入口。", plan: "在现有登录组件增加短信入口并验证" }),
    execute: async id => { executions.push(id); job = { ...job, status: "awaiting_merge", commitSha: "commit-1", implementationSummary: "已增加入口，验证通过。" }; },
    testCases: async () => undefined,
  };
  const addMessage = (text: string) => deps.update(job.jobId, { workbenchMessages: [...job.workbenchMessages!, { id: `input-${job.workbenchMessages!.length}`, role: "user", text, createdAt: "2026-10-13" }] });
  return { deps, executions, job: () => job, addMessage };
};

test("对话内生成用例保留原代码模式和 Review，随后仍可修改代码", async () => {
  const state = setup(); let generations = 0;
  state.deps.update("session-1", { commitSha: "code-commit", workbenchHasCodeChanges: true });
  state.deps.analyze = async () => ({ action: "test_cases", message: "我会生成当前需求的测试用例。", plan: "" });
  state.deps.testCases = async id => { generations++; state.deps.update(id, { taskMode: "test-case", status: "completed" }); };
  const worker = createWorkbenchWorker(state.deps);
  await worker.start("session-1");
  assert.equal(generations, 1);
  assert.equal(state.job().taskMode, "code");
  assert.equal(state.job().status, "awaiting_merge");
  assert.equal(state.job().commitSha, "code-commit");
  assert.equal(state.job().worktreePath, "/isolated/task-1");
  state.addMessage("再调整按钮文案");
  state.deps.analyze = async () => ({ action: "implement", message: "开始调整。", plan: "修改按钮文案" });
  await worker.start("session-1");
  assert.equal(generations, 1);
  assert.deepEqual(state.executions, ["session-1"]);
});

test("生成用例不把未合并的任务标为完成，失败时仍恢复原任务模式", async () => {
  const state = setup();
  state.deps.analyze = async () => ({ action: "test_cases", message: "生成测试用例。", plan: "" });
  state.deps.testCases = async id => { state.deps.update(id, { taskMode: "test-case", status: "completed" }); };
  const worker = createWorkbenchWorker(state.deps);
  await worker.start("session-1");
  assert.equal(state.job().status, "awaiting_input");
  assert.equal(state.job().workbenchNeedsInput, false);
  state.addMessage("补充异常用例");
  state.deps.testCases = async id => { state.deps.update(id, { taskMode: "test-case" }); throw new Error("模拟生成失败"); };
  await worker.start("session-1");
  assert.equal(state.job().status, "failed");
  assert.equal(state.job().taskMode, "code");
  assert.equal(state.job().worktreePath, "/isolated/task-1");
});

test("明确需求自动执行并等待审查，保留同一任务和工作区", async () => {
  const state = setup(); const worker = createWorkbenchWorker(state.deps);
  await worker.start("session-1");
  assert.deepEqual(state.executions, ["session-1"]);
  assert.equal(state.job().status, "awaiting_merge");
  assert.equal(state.job().worktreePath, "/isolated/task-1");
  assert.equal(state.job().workbenchProcessedInputs, 1);
  assert.equal(state.job().workbenchTurnRunning, false);
});

test("问题通过自然对话补充，多轮继续使用原任务", async () => {
  const state = setup(); const worker = createWorkbenchWorker(state.deps);
  state.deps.analyze = async job => job.workbenchProcessedInputs ? { action: "implement", message: "按三分钟有效期实现。", plan: "验证码有效期三分钟" } : { action: "needs_input", message: "验证码有效期希望设为多久？", plan: "" };
  await worker.start("session-1");
  assert.equal(state.job().status, "awaiting_input"); assert.equal(state.executions.length, 0);
  state.addMessage("三分钟就行"); await worker.start("session-1");
  assert.deepEqual(state.executions, ["session-1"]); assert.equal(state.job().workbenchProcessedInputs, 2);
});

test("解释和讨论不会触发代码执行，现有 Diff 保留", async () => {
  const state = setup();
  state.deps.update("session-1", { commitSha: "old-commit", status: "awaiting_merge" });
  state.deps.analyze = async () => ({ action: "reply", message: "这里沿用现有登录校验逻辑。", plan: "" });
  await createWorkbenchWorker(state.deps).start("session-1");
  assert.equal(state.executions.length, 0); assert.equal(state.job().status, "awaiting_merge"); assert.equal(state.job().commitSha, "old-commit");
});

test("分析过程中收到纠正，旧方案不会执行", async () => {
  const state = setup(); let rounds = 0;
  state.deps.analyze = async () => {
    if (++rounds === 1) state.addMessage("这里只改村财项目");
    return { action: "implement", message: "已理解要求。", plan: rounds === 1 ? "原方案" : "仅修改村财模块" };
  };
  await createWorkbenchWorker(state.deps).start("session-1");
  assert.equal(rounds, 2); assert.equal(state.executions.length, 1); assert.equal(state.job().planSummary, "仅修改村财模块");
});

test("执行过程中收到补充，串行接续，保留原工作区", async () => {
  const state = setup(); const originalExecute = state.deps.execute;
  state.deps.execute = async id => { await originalExecute(id); if (state.executions.length === 1) state.addMessage("按钮文案改成获取验证码"); };
  const worker = createWorkbenchWorker(state.deps);
  const first = worker.start("session-1"); const second = worker.start("session-1");
  assert.equal(first, second); await first;
  assert.deepEqual(state.executions, ["session-1", "session-1"]); assert.equal(state.job().worktreePath, "/isolated/task-1"); assert.equal(state.job().workbenchProcessedInputs, 2);
});

test("停止期间的旧分析不会执行，发消息后可以续接", async () => {
  const state = setup();
  const original = state.deps.analyze;
  state.deps.analyze = async job => { const result = await original(job); state.deps.update(job.jobId, { workbenchPauseRequested: true }); return result; };
  const worker = createWorkbenchWorker(state.deps); await worker.start("session-1");
  assert.equal(state.executions.length, 0); assert.equal(state.job().worktreePath, "/isolated/task-1");
  state.deps.analyze = original; state.deps.update("session-1", { workbenchPauseRequested: false }); state.addMessage("继续");
  await worker.start("session-1"); assert.equal(state.executions.length, 1);
});

test("结构化决策无效时不会冒然执行", () => {
  assert.throws(() => parseWorkbenchDecision("说明性文本"));
  assert.throws(() => parseWorkbenchDecision(JSON.stringify({ action: "implement", message: "开始修改", plan: " " })));
  assert.equal(parseWorkbenchDecision(JSON.stringify({ action: "needs_input", message: "使用哪个字段？", plan: "" })).action, "needs_input");
});

test("取消任务作为控制指令处理，不调用模型或执行代码", async () => {
  const state = setup();
  state.addMessage("取消这次任务");
  state.deps.analyze = async () => { throw new Error("取消不得调用模型"); };
  state.deps.cancel = async id => {
    state.deps.update(id, { status: "awaiting_input", workbenchReset: true, workbenchNeedsInput: false });
    return "任务回到未开始";
  };
  await createWorkbenchWorker(state.deps).start("session-1");
  assert.equal(state.job().workbenchReset, true);
  assert.equal(state.job().workbenchNeedsInput, false);
  assert.equal(state.job().workbenchProcessedInputs, 2);
  assert.equal(state.executions.length, 0);
});

test("普通回复不标记待补充，明确问题才标记", async () => {
  const state = setup();
  state.deps.analyze = async () => ({ action: "reply", message: "这段代码负责筛选。", plan: "" });
  const worker = createWorkbenchWorker(state.deps);
  await worker.start("session-1");
  assert.equal(state.job().workbenchNeedsInput, false);
  state.addMessage("开始实现");
  state.deps.analyze = async () => ({ action: "needs_input", message: "使用哪个业务字段？", plan: "" });
  await worker.start("session-1");
  assert.equal(state.job().workbenchNeedsInput, true);
});

test("基线提交或已确认无改动不能触发 Review", async () => {
  const state = setup();
  state.deps.update("session-1", { commitSha: "base", workbenchBaseCommitSha: "base", workbenchHasCodeChanges: false });
  state.deps.analyze = async () => ({ action: "reply", message: "尚未修改代码。", plan: "" });
  await createWorkbenchWorker(state.deps).start("session-1");
  assert.equal(state.job().status, "awaiting_input");
  assert.equal(state.job().workbenchNeedsInput, false);
});

test("取消任务识别不会误取消包含业务取消按钮的需求", () => {
  assert.equal(isWorkbenchCancellation("取消这次任务"), true);
  assert.equal(isWorkbenchCancellation("请取消本次执行。"), true);
  assert.equal(isWorkbenchCancellation("添加取消任务按钮"), false);
  assert.equal(isWorkbenchCancellation("不要取消这次任务"), false);
});

test("明确退回未开始作为控制指令执行，不让模型先承诺错误结果", async () => {
  const state = setup();
  state.addMessage("取消处理，改任务回到未开始");
  state.deps.analyze = async () => { throw new Error("不能调用模型"); };
  state.deps.cancel = async (id, reset) => {
    assert.equal(reset, true);
    state.deps.update(id, { workbenchReset: true, workbenchPauseRequested: false, status: "awaiting_input" });
    return "已回到未开始。";
  };
  await createWorkbenchWorker(state.deps).start("session-1");
  assert.equal(state.job().workbenchReset, true);
  assert.equal(state.job().workbenchPauseRequested, false);
  assert.deepEqual(state.executions, []);
  assert.equal(state.job().workbenchMessages?.at(-1)?.text, "已回到未开始。");
});

test("退回未开始识别不会误处理页面功能需求或否定语句", () => {
  for (const text of ["取消处理，改任务回到未开始", "请把这个任务退回未开始", "任务恢复为未开始状态", "回到未开始"]) assert.equal(isWorkbenchResetRequest(text), true, text);
  for (const text of ["不要回到未开始", "添加退回未开始按钮", "未开始列表的按钮需要修改", "停止执行并保留改动"]) assert.equal(isWorkbenchResetRequest(text), false, text);
});
