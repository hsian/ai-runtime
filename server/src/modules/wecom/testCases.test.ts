import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import express from "express";
import type { TestCaseDocument } from "../../types.js";

const directory = mkdtempSync(join(tmpdir(), "wecom-test-cases-"));
process.env.DATABASE_PATH = join(directory, "test.sqlite");
process.env.UPLOAD_DIR = join(directory, "uploads");
process.env.GIT_ACCESS_TOKEN = "test-only";
process.env.OPERATION_LOG_ENABLED = "false";
process.env.QWECHAT_BOT_ENABLED = "false";
process.env.CLIENT_COOKIE_SECRET = "wecom-test-case-secret";
process.env.QWECHAT_BOT_PREVIEW_HOST = "192.168.1.10:5173";
process.env.PORT = "6080";
process.env.AGENT_PROVIDER = "claude";
const store = await import("./sessionStore.js");
const { closeDatabase } = await import("../../services/database.js");
const { createJob, getJob, updateJob } = await import("../../services/jobStore.js");
const { parseCommand } = await import("./commands.js");
const { prepareTapdMessage } = await import("./tapdBridge.js");
const { saveImageBuffers } = await import("../../services/uploadService.js");
const { resolveIntent } = await import("./intentRouter.js");
const { dispatchCommand } = await import("./jobBridge.js");
const { requireCommandPermission } = await import("./permissions.js");
const { formatJob, progressStage } = await import("./replies.js");
const { testCaseDownloadUrl, authorizeTestCaseDownload } = await import("../../services/testCases/testCaseDownloadService.js");
const { testCaseDownloadsRouter, testCasesRouter } = await import("../../routes/testCases.js");
store.initWecomStore();
after(() => { closeDatabase(); rmSync(directory, { recursive: true, force: true }); });
const options = { botId: "test-cases", secret: "test", projectId: "b2b-composite" };
const document: TestCaseDocument = {
  moduleName: "Login", functionDescription: "Login validation",
  implementationAssessment: { recommendedResult: "已实现", summary: "Validation exists", evidence: [], gaps: [] },
  cases: [{ caseNumber: 1, priority: "高", levelOneModule: "Login", levelTwoModule: "Validation",
    requirementPoint: "Required fields", testPoint: "Empty username", preconditions: "Open login",
    steps: ["Submit empty username"], expectedResult: "Required field error" }],
};

test("explicit and natural-language test cases use a distinct read-only intent", async () => {
  const session = store.getSession(options.botId, "intent", "reader", options.projectId);
  for (const text of ["测试用例：登录校验", "生成测试用例: 登录校验"]) {
    assert.deepEqual(await resolveIntent(parseCommand(text), session, async () => { throw new Error("Unexpected classifier"); }),
      { action: "test-case", text: "登录校验" });
  }
  const result = await resolveIntent(parseCommand("给登录生成测试用例"), session,
    async () => JSON.stringify({ intent: "test-case", prompt: "登录校验", reply: "", topicId: "new", topicTitle: "登录" }));
  assert.equal(result.action, "test-case");
  assert.equal(result.topicId, "new");
});

test("read-only submission binds a running test-case job without execution confirmation", async () => {
  const session = store.getSession(options.botId, "submit", "reader", options.projectId);
  const stopBeforeAgent = new Error("Stop before external agent");
  let jobId = "";
  await assert.rejects(dispatchCommand(session, { action: "test-case", text: "Login cases" }, "submit-cases", options,
    id => { jobId = id; throw stopBeforeAgent; }), error => error === stopBeforeAgent);
  const job = getJob(jobId)!;
  assert.equal(job.taskMode, "test-case");
  assert.equal(job.status, "running");
  assert.equal(job.requiresConfirm, false);
  assert.equal(job.ownerId, session.owner_id);
  assert.ok(store.getBinding(jobId, session.session_key));
  assert.doesNotThrow(() => requireCommandPermission(session, { action: "cancel", jobId }, options));
  await dispatchCommand(session, { action: "cancel", jobId }, "cancel-cases", options);
  assert.equal(getJob(jobId)?.status, "cancelled");
});

test("Codex prefix applies only at the beginning and preserves explicit control commands", () => {
  assert.deepEqual(parseCommand("  #codex 问答：登录逻辑"), { action: "question", text: "登录逻辑", agentProvider: "codex" });
  assert.deepEqual(parseCommand("#CODEX：测试用例：登录"), { action: "test-case", text: "登录", agentProvider: "codex" });
  assert.deepEqual(parseCommand("#codex\n修改：按钮颜色"), { action: "plan", text: "按钮颜色", agentProvider: "codex" });
  assert.deepEqual(parseCommand("说明 #codex 的含义"), { action: "auto", text: "说明 #codex 的含义" });
  assert.deepEqual(parseCommand("#codexx 登录"), { action: "auto", text: "#codexx 登录" });
  assert.deepEqual(parseCommand("#codex 执行"), { action: "execute", jobId: undefined });
  assert.deepEqual(parseCommand("#codex 取消"), { action: "cancel", jobId: undefined });
  assert.equal(parseCommand("#codex").action, "chat");
});

test("semantic routing strips Codex marker and retains the explicit task engine", async () => {
  const session = store.getSession(options.botId, "codex-intent", "reader", options.projectId);
  const prepared = await prepareTapdMessage(session, "#codex 给登录生成测试用例");
  const command = await resolveIntent(prepared.command, session, async input => {
    assert.equal(JSON.parse(input).message, "给登录生成测试用例");
    assert.doesNotMatch(input, /#codex/);
    return JSON.stringify({ intent: "test-case", prompt: "登录用例", reply: "", topicId: "new", topicTitle: "登录" });
  });
  assert.equal(command.agentProvider, "codex");
  assert.equal(command.action, "test-case");
  const next = await resolveIntent(parseCommand("给登录生成测试用例"), session, async () =>
    JSON.stringify({ intent: "test-case", prompt: "登录用例", reply: "", topicId: "new", topicTitle: "登录" }));
  assert.equal(next.agentProvider, undefined);
});

test("question, change and test-case jobs pin Codex once without changing subsequent defaults", async () => {
  const session = store.getSession(options.botId, "codex-jobs", "reader", options.projectId);
  const allowed = { ...options, codeAllowedUserIds: ["reader"] };
  const stopBeforeAgent = new Error("Stop before external agent");
  for (const prefix of ["问答", "修改", "测试用例"]) {
    for (const codex of [true, false]) {
      const command = parseCommand(`${codex ? "#codex " : ""}${prefix}：登录`);
      let jobId = "";
      await assert.rejects(dispatchCommand(session, command, `${prefix}-${codex}`, allowed,
        id => { jobId = id; throw stopBeforeAgent; }), error => error === stopBeforeAgent);
      const job = getJob(jobId)!;
      assert.equal(job.agentProvider, codex ? "codex" : "claude");
      assert.equal(job.wecomExplicitEngine, codex);
      assert.equal(job.prompt, "登录");
      updateJob(jobId, { status: "completed" });
    }
  }
});

test("TAPD requests retain the message prefix, while a bare tagged link only reads the requirement", async () => {
  const session = store.getSession(options.botId, "codex-tapd", "reader", options.projectId);
  const url = "https://www.tapd.cn/123/stories/view/789";
  const loader = async () => ({ snapshotId: randomUUID(), context: { url, workspaceId: "123", itemType: "story" as const,
    itemId: "789", title: "Login", description: "Validation", commentCount: 0, fetchedAt: new Date().toISOString() },
    attachments: [], warnings: [] });
  const prepared = await prepareTapdMessage(session, `#codex ${url} 生成用例`, loader);
  assert.equal(prepared.command.agentProvider, "codex");
  assert.equal(prepared.command.action, "auto");
  assert.equal("text" in prepared.command && prepared.command.text, "生成用例");
  assert.equal(prepared.command.topicId, session.conversation_id);
  const explicit = await prepareTapdMessage(session, `#codex 测试用例：${url} 登录校验`, loader);
  assert.equal(explicit.command.action, "test-case");
  assert.equal(explicit.command.agentProvider, "codex");
  const bare = await prepareTapdMessage(session, `#codex ${url}`, loader);
  assert.equal(bare.command.action, "chat");
  assert.equal(bare.command.agentProvider, undefined);
});

test("TAPD-linked generation copies requirement and image snapshots into the test-case job", async () => {
  const session = store.getSession(options.botId, "tapd", "reader", options.projectId);
  const url = "https://www.tapd.cn/123/stories/view/456";
  const snapshotId = randomUUID();
  const attachments = saveImageBuffers(snapshotId, [
    { name: "tapd.png", mime: "image/png", buffer: Buffer.from("image fixture") },
  ]);
  const prepared = await prepareTapdMessage(session, `生成测试用例：${url}`, async () => ({
    snapshotId, context: { url, workspaceId: "123", itemType: "story", itemId: "456",
      title: "Login", description: "Username is required", commentCount: 0, imageCount: 1, fetchedAt: new Date().toISOString() },
    attachments, warnings: [],
  }));
  const command = await resolveIntent(prepared.command, session, async () => JSON.stringify({
    intent: "test-case", prompt: "Generate cases for this requirement", reply: "", topicId: prepared.topicId, topicTitle: "Login",
  }));
  const stopBeforeAgent = new Error("Stop before external agent");
  let jobId = "";
  await assert.rejects(dispatchCommand(session, command, "tapd-cases", options,
    id => { jobId = id; throw stopBeforeAgent; }), error => error === stopBeforeAgent);
  const job = getJob(jobId)!;
  assert.equal(job.tapdContext?.description, "Username is required");
  assert.equal(job.attachments?.length, 1);
  assert.notEqual(job.attachments![0].path, attachments[0].path);
  assert.equal(readFileSync(job.attachments![0].path, "utf8"), "image fixture");
});

test("test-case generation preserves a plan waiting for confirmation in the same topic", async () => {
  const session = store.getSession(options.botId, "plan", "reader", options.projectId);
  const plan = createJob({ prompt: "Modify login", ownerId: session.owner_id, conversationId: session.conversation_id, taskMode: "code" });
  updateJob(plan.jobId, { status: "awaiting_confirm", planSummary: "Modify validation" });
  store.bindJob(session, plan.jobId);
  const stopBeforeAgent = new Error("Stop before external agent");
  let jobId = "";
  await assert.rejects(dispatchCommand(session, { action: "test-case", text: "Login cases", topicId: session.conversation_id },
    "plan-cases", options, id => { jobId = id; throw stopBeforeAgent; }), error => error === stopBeforeAgent);
  assert.equal(store.getSession(options.botId, "plan", "reader", options.projectId).active_job_id, plan.jobId);
  assert.equal(getJob(plan.jobId)?.status, "awaiting_confirm");
  assert.equal(getJob(jobId)?.taskMode, "test-case");
});

test("completion includes Excel link; credentials reject tampering, expiry and other jobs", () => {
  const created = createJob({ prompt: "Login", taskMode: "test-case", ownerId: "reader" });
  const job = updateJob(created.jobId, { status: "completed", testCaseDocument: document })!;
  const now = Date.now();
  const url = new URL(testCaseDownloadUrl(job, now)!);
  assert.equal(url.origin, "http://192.168.1.10:6080");
  assert.equal(new URL(testCaseDownloadUrl({ ...job, previewHost: "192.168.1.20:8080" }, now)!).origin,
    "http://192.168.1.20:6080");
  assert.equal(new URL(testCaseDownloadUrl({ ...job, previewHost: "[fd00::1]:5173" }, now)!).origin,
    "http://[fd00::1]:6080");
  const token = url.searchParams.get("token")!;
  assert.equal(authorizeTestCaseDownload(job, token, now), true);
  assert.equal(authorizeTestCaseDownload(job, `${token.slice(0, -1)}!`, now), false);
  assert.equal(authorizeTestCaseDownload(job, token, now + 24 * 60 * 60 * 1000), false);
  assert.equal(authorizeTestCaseDownload({ ...job, jobId: "another-job" }, token, now), false);
  assert.equal(authorizeTestCaseDownload({ ...job, ownerId: "another-owner" }, token, now), false);
  assert.equal(authorizeTestCaseDownload({ ...job, taskMode: "code" }, token, now), false);
  assert.equal(authorizeTestCaseDownload(job, undefined, now), false);
  assert.match(formatJob(job), /共 1 条/);
  assert.match(formatJob(job), /下载 Excel/);
  assert.equal(progressStage(job, "test_case"), "正在分析需求并设计测试用例");
  assert.doesNotThrow(() => formatJob({ ...job, testCaseDocument: { ...document, implementationAssessment: undefined } }));
  delete process.env.QWECHAT_BOT_PREVIEW_HOST;
  assert.match(formatJob(job), /下载 Excel/);
  assert.doesNotMatch(formatJob(job), /尚未配置/);
  assert.equal(new URL(testCaseDownloadUrl(job)!).port, "6080");
  process.env.QWECHAT_BOT_PREVIEW_HOST = "192.168.1.10:5173";
});

test("completed task replies identify only explicitly selected Codex after the answer and download links", () => {
  const created = createJob({ prompt: "#codex is just text here", taskMode: "question", agentProvider: "claude" });
  const completed = updateJob(created.jobId, { status: "completed", message: "Answer" })!;
  assert.doesNotMatch(formatJob(completed), /本次回答执行引擎/);
  assert.doesNotMatch(formatJob({ ...completed, projectId: "yuenongjiao-mini" }), /本次回答执行引擎/);
  assert.doesNotMatch(formatJob({ ...completed, agentProvider: "codex" }), /本次回答执行引擎/);
  assert.doesNotMatch(formatJob({ ...completed, wecomExplicitEngine: true }), /本次回答执行引擎/);
  const explicit = { ...completed, agentProvider: "codex" as const, wecomExplicitEngine: true };
  assert.match(formatJob(explicit), /本次回答执行引擎为 codex。$/);
  for (const status of ["awaiting_confirm", "awaiting_input"] as const) {
    assert.match(formatJob({ ...explicit, status, planSummary: "Plan" }), /本次回答执行引擎为 codex。$/);
    assert.doesNotMatch(formatJob({ ...completed, status, planSummary: "Plan" }), /本次回答执行引擎/);
  }
  assert.match(formatJob({ ...explicit, taskMode: "code", implementationSummary: "Done",
    previewUrl: "http://192.168.1.10:5173" }), /本次回答执行引擎为 codex。$/);
  const cases = formatJob({ ...explicit, taskMode: "test-case", testCaseDocument: document });
  assert.match(cases, /下载 Excel/);
  assert.match(cases, /本次回答执行引擎为 codex。$/);
  assert.doesNotMatch(formatJob({ ...explicit, agentProvider: undefined }), /本次回答执行引擎/);
  assert.doesNotMatch(formatJob({ ...explicit, status: "running" }), /本次回答执行引擎/);
  assert.doesNotMatch(formatJob({ ...explicit, revertedFromDefaultAt: new Date().toISOString() }), /本次回答执行引擎/);
});

test("signed download works without login while the normal Web route stays protected", async () => {
  const created = createJob({ prompt: "Download", taskMode: "test-case", ownerId: "wecom-owner" });
  const job = updateJob(created.jobId, { status: "completed", testCaseDocument: document })!;
  const app = express();
  app.use("/api/test-case-downloads", testCaseDownloadsRouter);
  app.use("/api/test-cases", testCasesRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address() as { port: number };
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const signed = new URL(testCaseDownloadUrl(job)!);
    const response = await fetch(`${origin}${signed.pathname}${signed.search}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type")!, /spreadsheetml/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const workbook = Buffer.from(await response.arrayBuffer());
    assert.equal(workbook.subarray(0, 2).toString(), "PK");
    assert.equal((await fetch(`${origin}${signed.pathname}`)).status, 404);
    assert.equal((await fetch(`${origin}/api/test-cases/${job.jobId}/download${signed.search}`)).status, 404);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
