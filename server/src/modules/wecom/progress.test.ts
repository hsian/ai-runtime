import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WSClient } from "@wecom/aibot-node-sdk";
import type { MessageFrame } from "./client.js";

const directory = mkdtempSync(join(tmpdir(), "wecom-progress-test-"));
process.env.DATABASE_PATH = join(directory, "test.sqlite");
process.env.GIT_ACCESS_TOKEN = "test-only";
process.env.QWECHAT_BOT_ENABLED = "false";
process.env.OPERATION_LOG_ENABLED = "false";
const { closeDatabase } = await import("../../services/database.js");
const { createJob, updateJob, getJob } = await import("../../services/jobStore.js");
const { appendJobEvent } = await import("../../services/jobEvents.js");
const { initWecomStore, getSession, bindJob } = await import("./sessionStore.js");
const { ResponseCoordinator } = await import("./responseCoordinator.js");
const { progressStage, formatProgress } = await import("./replies.js");
const { parseCommand } = await import("./commands.js");
const { dispatchCommand } = await import("./jobBridge.js");
const { setDialogue } = await import("./dialogueStore.js");
initWecomStore();
after(() => { closeDatabase(); rmSync(directory, { recursive: true, force: true }); });

function setup(lifetime = 90_000) {
  let now = 0;
  const calls: { text: string; finish?: boolean; streamId?: string }[] = [];
  const client = { async replyStream(_frame: unknown, streamId: string, text: string, finish: boolean) { calls.push({ text, finish, streamId }); },
    async sendMessage(_target: string, message: { markdown: { content: string } }) { calls.push({ text: message.markdown.content }); } } as unknown as WSClient;
  const job = createJob({ prompt: "账套标题改为蓝色", ownerId: "progress-owner", taskMode: "code" });
  updateJob(job.jobId, { status: "running" });
  const coordinator = new ResponseCoordinator(client, lifetime, () => now);
  coordinator.track(job.jobId, { body: { chattype: "single", from: { userid: "alice" } } } as MessageFrame, "same-stream", "alice");
  return { job, coordinator, calls, time(value: number) { now = value; } };
}

test("progress uses actual phases, formats elapsed time and prioritizes queue state", () => {
  const job = createJob({ prompt: "test", ownerId: "format" });
  assert.equal(formatProgress(job, "agent", 80_000), "正在分析并修改代码 · 已用时 1分20秒");
  assert.equal(progressStage({ ...job, jobsAhead: 2 }, "agent"), "正在排队，前面还有 2 个任务");
  assert.equal(progressStage(job, "unknown_internal_phase"), "正在等待处理");
  assert.doesNotMatch(formatProgress(job, "agent", 80_000), /%|任务：|Thinking/);
});

test("stream updates are throttled, reuse the message and ignore raw Agent logs", async () => {
  const context = setup();
  try {
    appendJobEvent(context.job.jobId, { type: "stage", phase: "agent" });
    await context.coordinator.refresh();
    assert.match(context.calls[0].text, /分析并修改代码/);
    appendJobEvent(context.job.jobId, { type: "agent_tool", toolName: "Bash", toolDetail: "SECRET_INTERNAL_COMMAND" });
    context.time(1000);
    await context.coordinator.refresh();
    assert.equal(context.calls.length, 1);
    context.time(10_000);
    await context.coordinator.refresh();
    assert.match(context.calls[1].text, /已用时 10秒/);
    assert.ok(context.calls.every(call => call.streamId === "same-stream" && call.finish === false && !call.text.includes("SECRET")));
    await context.coordinator.finish(context.job.jobId, "修改完成");
    context.time(20_000);
    await context.coordinator.refresh();
    assert.equal(context.calls.length, 3);
    assert.equal(context.calls[2].finish, true);
  } finally { context.coordinator.stop(); }
});

test("long tasks send only throttled phase changes after stream closure, not periodic cards", async () => {
  const context = setup(0);
  try {
    appendJobEvent(context.job.jobId, { type: "stage", phase: "agent" });
    await context.coordinator.refresh();
    assert.match(context.calls[0].text, /结果稍后通知/);
    assert.equal(context.calls[0].finish, true);
    context.time(40_000);
    await context.coordinator.refresh();
    assert.equal(context.calls.length, 1);
    appendJobEvent(context.job.jobId, { type: "stage", phase: "commit" });
    await context.coordinator.refresh();
    assert.match(context.calls[1].text, /整理并提交改动/);
    appendJobEvent(context.job.jobId, { type: "stage", phase: "merge" });
    context.time(45_000);
    await context.coordinator.refresh();
    assert.equal(context.calls.length, 2);
    context.time(70_000);
    await context.coordinator.refresh();
    assert.match(context.calls[2].text, /合并改动/);
    updateJob(context.job.jobId, { status: "completed" });
    context.time(100_000);
    await context.coordinator.refresh();
    assert.equal(context.calls.length, 3);
    assert.equal(await context.coordinator.finish(context.job.jobId, "已完成"), false);
  } finally { context.coordinator.stop(); }
});

test("the progress command shows the latest real phase without invoking Agent or exposing IDs", async () => {
  const options = { botId: "progress-bot", secret: "test", projectId: "b2b-composite" };
  const session = getSession(options.botId, "reader", "reader", options.projectId);
  const job = createJob({ prompt: "问颜色", ownerId: session.owner_id, taskMode: "question", conversationId: session.conversation_id });
  updateJob(job.jobId, { status: "running" });
  bindJob(session, job.jobId);
  appendJobEvent(job.jobId, { type: "stage", phase: "question" });
  assert.equal(parseCommand("进度").action, "status");
  const text = await dispatchCommand({ ...session, active_job_id: job.jobId }, parseCommand("进度"), "progress-command", options);
  assert.equal(text, "正在读取项目代码");
  assert.doesNotMatch(text, new RegExp(getJob(job.jobId)!.jobId));
});

test("a queued revert still reports progress even though its source job remains completed", async () => {
  const context = setup();
  const session = getSession("revert-progress", "alice", "alice", "b2b-composite");
  updateJob(context.job.jobId, { status: "completed" });
  setDialogue(session, { step: "reverting", sourceJobId: context.job.jobId });
  try {
    await context.coordinator.refresh();
    assert.match(context.calls[0].text, /等待撤回处理/);
    appendJobEvent(context.job.jobId, { type: "stage", phase: "default_revert" });
    context.time(10_000);
    await context.coordinator.refresh();
    assert.match(context.calls[1].text, /正在撤回修改/);
    setDialogue(session);
    context.time(20_000);
    await context.coordinator.refresh();
    assert.equal(context.calls.length, 2);
  } finally { context.coordinator.stop(); setDialogue(session); }
});
