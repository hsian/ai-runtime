import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const directory = mkdtempSync(join(tmpdir(), "wecom-release-test-"));
Object.assign(process.env, { DATABASE_PATH: join(directory, "test.sqlite"), GIT_ACCESS_TOKEN: "test-only", OPERATION_LOG_ENABLED: "false" });
const store = await import("./sessionStore.js");
const { createJob, getJob, updateJob } = await import("../../services/jobStore.js");
const { releaseConversationJob } = await import("./releaseMerge.js");
const { closeDatabase } = await import("../../services/database.js");
store.initWecomStore();
after(() => { closeDatabase(); rmSync(directory, { recursive: true, force: true }); });
const options = { botId: "release", secret: "test", projectId: "b2b-composite", codeAllowedUserIds: ["alice"] };
const session = store.getSession("release", "alice", "alice", "b2b-composite");
const job = createJob({ prompt: "登录修复", ownerId: session.owner_id, conversationId: session.conversation_id, taskMode: "code" });
updateJob(job.jobId, { status: "completed", mergedToDefaultAt: "2026-10-15", mergedToDefaultBranch: "test", branch: "test", sourceBranch: "feature/login", sourceCommitSha: "code-sha", commitSha: "code-sha" });
store.bindJob(session, job.jobId);
const writes: string[][] = [];
const ops = {
  branches: async () => ["test", "20260930", "release/202610"],
  merge: async (id: string, branch: string) => { writes.push([id, branch]); updateJob(id, { releaseMerges: [{ targetBranch: branch, status: "completed", commitSha: "release-sha", mergedAt: "2026-10-15" }] }); },
};

test("ordinary chat uses the controlled release service and retries do not merge twice", async () => {
  const command = { jobId: job.jobId, targetBranch: "20260930" };
  assert.match(await releaseConversationJob(session, command, options, ops), /20260930/);
  assert.deepEqual(writes, [[job.jobId, "20260930"]]);
  assert.match(await releaseConversationJob(session, command, options, ops), /无需重复/);
  assert.equal(writes.length, 1);
  assert.equal(getJob(job.jobId)?.sourceCommitSha, "code-sha");
  assert.equal(getJob(job.jobId)?.branch, "test");
});

test("missing branches, unrelated jobs and missing code permission never merge", async () => {
  const count = writes.length;
  await assert.rejects(releaseConversationJob(session, { jobId: job.jobId, targetBranch: "missing" }, options, ops), /不存在/);
  await assert.rejects(releaseConversationJob(session, { jobId: job.jobId, targetBranch: "test; rm" }, options, ops), /无效/);
  await assert.rejects(releaseConversationJob(session, { jobId: job.jobId, targetBranch: "release/202610" }, { ...options, codeAllowedUserIds: [] }, ops), /只有问答权限/);
  const stranger = store.getSession("release", "bob", "bob", "b2b-composite");
  await assert.rejects(releaseConversationJob(stranger, { jobId: job.jobId, targetBranch: "release/202610" }, { ...options, codeAllowedUserIds: ["bob"] }, ops), /没有属于当前会话/);
  updateJob(job.jobId, { status: "awaiting_merge" });
  await assert.rejects(releaseConversationJob(session, { jobId: job.jobId, targetBranch: "release/202610" }, options, ops), /没有属于当前会话/);
  updateJob(job.jobId, { status: "completed", revertedFromDefaultAt: "2026-10-15" });
  await assert.rejects(releaseConversationJob(session, { jobId: job.jobId, targetBranch: "release/202610" }, options, ops), /没有属于当前会话/);
  updateJob(job.jobId, { revertedFromDefaultAt: undefined });
  assert.equal(writes.length, count);
});

test("failed release preserves source commit for retry and never creates a new code task", async () => {
  await assert.rejects(releaseConversationJob(session, { jobId: job.jobId, targetBranch: "release/202610" }, options, { ...ops, merge: async () => { throw new Error("simulated conflict"); } }), /simulated conflict/);
  assert.equal(getJob(job.jobId)?.status, "completed");
  assert.equal(getJob(job.jobId)?.sourceCommitSha, "code-sha");
  await releaseConversationJob(session, { jobId: job.jobId, targetBranch: "release/202610" }, options, ops);
  assert.deepEqual(writes.at(-1), [job.jobId, "release/202610"]);
});
