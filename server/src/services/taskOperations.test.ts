import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "task-operations-"));
Object.assign(process.env, { DATABASE_PATH: join(root, "test.sqlite"), GIT_ACCESS_TOKEN: "test", OPERATION_LOG_ENABLED: "false" });
const { createJob, updateJob, getJob } = await import("./jobStore.js");
const { closeDatabase } = await import("./database.js");
const { requestTaskMerge } = await import("./taskOperations.js");
const { getProject } = await import("./projectRegistry.js");
after(() => { closeDatabase(); rmSync(root, { recursive: true, force: true }); });

test("all entry points share the same completion gate and queue reservation", () => {
  const job = createJob({ prompt: "fixture", taskMode: "code" });
  updateJob(job.jobId, { workbenchSession: true, status: "awaiting_merge", commitSha: "code", workbenchBaseCommitSha: "base", workbenchTurnRunning: true });
  let queued = 0;
  const enqueue = () => ++queued;
  assert.throws(() => requestTaskMerge(job.jobId, { enqueue }), /本轮尚未结束/);
  assert.equal(queued, 0);
  assert.equal(getJob(job.jobId)?.status, "awaiting_merge");
  updateJob(job.jobId, { workbenchTurnRunning: false });
  assert.equal(requestTaskMerge(job.jobId, { enqueue }), 1);
  assert.equal(getJob(job.jobId)?.status, "pending");
  assert.throws(() => requestTaskMerge(job.jobId, { enqueue }), /当前状态不可合并/);
  assert.equal(queued, 1, "a second channel cannot enqueue the same completion twice");
});

test("analysis-only output cannot be completed but can be explicitly discarded", () => {
  const job = createJob({ prompt: "analysis" });
  updateJob(job.jobId, { workbenchSession: true, status: "awaiting_merge", commitSha: "base", workbenchBaseCommitSha: "base" });
  assert.throws(() => requestTaskMerge(job.jobId, { enqueue: () => 0 }), /实际代码修改/);
  requestTaskMerge(job.jobId, { discard: true, enqueue: () => 0 });
  assert.equal(getJob(job.jobId)?.status, "pending");
});

test("a queued merge returns to confirmation when the pinned version changes", async () => {
  const job = createJob({ prompt: "merge fixture", taskMode: "code" });
  const originalCommit = "a".repeat(40);
  updateJob(job.jobId, { status: "awaiting_merge", branch: "feature", sourceCommitSha: originalCommit });
  let runMerge!: (jobId: string) => Promise<void>;
  requestTaskMerge(job.jobId, {
    confirmedVersion: { commit: originalCommit, targetBranch: getProject(job.projectId).defaultBranch },
    enqueue(_jobId, worker) { runMerge = worker; return 1; },
  });
  updateJob(job.jobId, { sourceCommitSha: "b".repeat(40) });
  await assert.rejects(runMerge(job.jobId), /版本或目标分支已变化/);
  assert.equal(getJob(job.jobId)?.status, "awaiting_merge");
});
