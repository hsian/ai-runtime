import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testRoot = await mkdtemp(join(tmpdir(), "ai-runtime-sqlite-"));

process.env.GIT_REPO_URL = "https://example.com/test/repo.git";
process.env.GIT_ACCESS_TOKEN = "test-token";
process.env.DATABASE_PATH = join(testRoot, "ai-runtime.sqlite");
process.env.WORKSPACE_DIR = join(testRoot, "workspace");
process.env.WORKTREE_DIR = join(testRoot, "worktrees");
process.env.UPLOAD_DIR = join(testRoot, "uploads");
process.env.OPERATION_LOG_DIR = join(testRoot, "logs");
process.env.OPERATION_LOG_ENABLED = "false";

try {
  const { closeDatabase, getDatabase } = await import("../dist/services/database.js");
  const {
    createJob,
    deleteJob,
    getJob,
    initJobStore,
    updateJob,
  } = await import("../dist/services/jobStore.js");
  const { appendJobEvent, getJobEvents } = await import("../dist/services/jobEvents.js");
  const { cleanupExpiredJobs } = await import("../dist/services/housekeeping.js");

  initJobStore();

  const completed = createJob({
    ownerId: "owner-1",
    conversationId: "conversation-1",
    prompt: "持久化测试",
  });
  updateJob(completed.jobId, { status: "completed", message: "任务完成" });
  appendJobEvent(completed.jobId, { type: "done", text: "任务完成" });

  const interrupted = createJob({ ownerId: "owner-1", prompt: "运行中任务" });
  updateJob(interrupted.jobId, { status: "running" });

  const awaitingConfirm = createJob({ ownerId: "owner-1", prompt: "等待确认任务" });
  updateJob(awaitingConfirm.jobId, { status: "awaiting_confirm", planSummary: "测试方案" });

  closeDatabase();
  initJobStore();

  assert.equal(getJob(completed.jobId)?.message, "任务完成");
  assert.equal(getJobEvents(completed.jobId).length, 1);
  assert.equal(getJob(interrupted.jobId)?.status, "failed");
  assert.match(getJob(interrupted.jobId)?.error ?? "", /服务发生重启/);
  assert.equal(getJob(awaitingConfirm.jobId)?.status, "awaiting_confirm");

  const expired = createJob({ ownerId: "owner-2", prompt: "过期任务" });
  updateJob(expired.jobId, { status: "failed" });
  getDatabase()
    .prepare("UPDATE jobs SET updated_at = '2000-01-01T00:00:00.000Z' WHERE job_id = ?")
    .run(expired.jobId);
  assert.equal(await cleanupExpiredJobs(), 1);
  assert.equal(getJob(expired.jobId), undefined);

  assert.equal(deleteJob(completed.jobId), true);
  assert.equal(getJobEvents(completed.jobId).length, 0);

  closeDatabase();
  console.log("SQLite persistence verification passed");
} finally {
  await rm(testRoot, { recursive: true, force: true });
}
