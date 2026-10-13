import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

// Isolated local Git remote + SQLite + fake CLI: never uses the configured business repository.
const originalDirectory = process.cwd();
const root = await mkdtemp(join(tmpdir(), "ai-runtime-workbench-verification-"));
const remote = join(root, "remote.git");
const seed = join(root, "seed");
const workspace = join(root, "workspace");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const waitFor = async (predicate, description) => {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(done => setTimeout(done, 80)); }
  throw new Error("Timeout: " + description);
};
await mkdir(seed);
git(root, "init", "--bare", remote);
git(seed, "init", "-b", "main");
git(seed, "config", "user.name", "Workbench Test");
git(seed, "config", "user.email", "workbench@example.com");
await writeFile(join(seed, "base.txt"), "base\n");
git(seed, "add", "."); git(seed, "commit", "-m", "base");
git(seed, "remote", "add", "origin", remote); git(seed, "push", "-u", "origin", "main");
git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
git(root, "clone", remote, workspace);
git(workspace, "config", "user.name", "Workbench Test"); git(workspace, "config", "user.email", "workbench@example.com");
git(workspace, "remote", "set-url", "origin", pathToFileURL(remote).href);
await writeFile(join(root, "projects.json"), JSON.stringify([{ id: "b2b-composite", name: "Local Verification", type: "generic", gitRepoUrl: pathToFileURL(remote).href, defaultBranch: "main", workspaceDir: workspace, worktreeDir: join(root, "worktrees"), autoMerge: true }]));
const fakeAgent = join(root, "fake-agent.cjs");
await writeFile(fakeAgent, String.raw`
const fs = require('node:fs');
let prompt = '';
process.stdin.setEncoding('utf8'); process.stdin.on('data', text => prompt += text);
process.stdin.on('end', () => {
  const args = process.argv.slice(2);
  const outputIndex = args.indexOf('--output-last-message');
  const latest = [...prompt.matchAll(/用户：([^\n]+)/g)].at(-1)?.[1] || '';
  if (outputIndex >= 0) {
    const result = latest.includes('开始处理') ? { action: 'needs_input', message: '验证码有效期希望设为多久？', plan: '' } : { action: 'implement', message: '我会结合最新补充继续修改并验证。', plan: '按最新要求修改当前工作区中的登录功能，执行适当验证。' };
    fs.writeFileSync(args[outputIndex + 1], JSON.stringify(result));
    return;
  }
  if (latest.includes('慢速修改')) {
    fs.writeFileSync('partial.txt', 'preserved work\n');
    setInterval(() => {}, 1000); return;
  }
  const target = !fs.existsSync('first.txt') ? 'first.txt' : !fs.existsSync('second.txt') ? 'second.txt' : 'continued.txt';
  fs.writeFileSync(target, 'task change\n');
  process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '已完成当前修改，验证通过。' } }) + '\n');
});
`);
const cli = join(root, process.platform === "win32" ? "fake-agent.cmd" : "fake-agent");
await writeFile(cli, process.platform === "win32" ? `@echo off\r\n"${process.execPath}" "${fakeAgent}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${fakeAgent}" "$@"\n`, { mode: 0o755 });
Object.assign(process.env, { GIT_ACCESS_TOKEN: "test-token", AGENT_PROVIDER: "codex", CODEX_CLI_PATH: cli, CODEX_MODEL: "", CODEX_PROFILE: "", CODEX_ENABLE_SYSTEM_PROXY: "false", CODEX_TIMEOUT_MS: "20000", AUTO_PUSH: "false", PUSH_FEATURE_BRANCH: "false", GIT_SKIP_HOOKS: "true", PREVIEW_DEV_ENABLED: "false", API_DOC_SOURCES: "[]", DATABASE_PATH: join(root, "test.sqlite"), UPLOAD_DIR: join(root, "uploads"), OPERATION_LOG_ENABLED: "false" });
process.chdir(root);
Object.assign(process.env, { TAPD_CLIENT_ID: "test", TAPD_CLIENT_SECRET: "test", TAPD_WORKSPACE_ID: "123", TAPD_API_BASE: "https://tapd.invalid", TAPD_WORKSPACES: '[{"id":"123","name":"Test"}]' });
const originalFetch = globalThis.fetch;
let tapdStatus = "open";
let failCompletion = true;
let completionWrites = 0;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  assert.equal(url.hostname, "tapd.invalid", "isolated mock must never contact real TAPD");
  if (url.pathname === "/tokens/request_token") return Response.json({ status: 1, data: { access_token: "test", expires_in: 3600 } });
  assert.equal(url.pathname, "/tasks");
  if (init?.method === "POST") {
    const body = new URLSearchParams(String(init.body));
    assert.equal(body.get("id"), "456");
    if (body.get("status") === "done") {
      completionWrites++;
      if (failCompletion) return Response.json({ status: 0, info: "test sync unavailable" });
    }
    tapdStatus = body.get("status");
  }
  return Response.json({ status: 1, data: [{ Task: { id: "456", status: tapdStatus, owner: "alice;" } }] });
};
const moduleRoot = new URL("../dist/services/", import.meta.url);
const { createJob, getJob, updateJob, initJobStore } = await import(new URL("jobStore.js", moduleRoot));
const { receiveWorkbenchMessage, pauseWorkbenchSession } = await import(new URL("workbenchSession.js", moduleRoot));
const { getProjectGitService } = await import(new URL("projectRuntime.js", moduleRoot));
const { confirmJobMerge } = await import(new URL("jobMergeService.js", moduleRoot));
const { closeDatabase } = await import(new URL("database.js", moduleRoot));
const { syncWorkbenchTask } = await import(new URL("tapd/taskStatusSync.js", moduleRoot));
try {
  initJobStore();
  const job = createJob({ prompt: "实现短信登录入口", ownerId: "alice", conversationId: "task-1", projectId: "b2b-composite", agentProvider: "codex", taskMode: "code" });
  updateJob(job.jobId, { workbenchSession: true, status: "awaiting_input", tapdTask: { workspaceId: "123", taskId: "456" }, tapdOperator: "alice" });
  receiveWorkbenchMessage(job.jobId, "请开始处理这个需求。");
  await waitFor(() => getJob(job.jobId)?.status === "awaiting_input" && !getJob(job.jobId)?.workbenchTurnRunning, "natural clarification");
  const worktree = getJob(job.jobId).worktreePath;
  assert.equal(tapdStatus, "progressing");
  await assert.rejects(syncWorkbenchTask(job.jobId, "done"), /尚未合并/);
  assert.ok(worktree); assert.equal(getJob(job.jobId).workbenchMessages.at(-1).role, "assistant");
  updateJob(job.jobId, { status: "awaiting_confirm", planSummary: "旧版仅生成的计划" });
  receiveWorkbenchMessage(job.jobId, "取消这次任务");
  await waitFor(() => getJob(job.jobId)?.workbenchReset && !getJob(job.jobId)?.workbenchTurnRunning, "cancel without code changes");
  assert.equal(getJob(job.jobId).workbenchNeedsInput, false);
  assert.equal(getJob(job.jobId).commitSha, undefined);
  assert.equal(getJob(job.jobId).planSummary, undefined);
  assert.equal(tapdStatus, "open");
  assert.equal(await getProjectGitService(job.projectId).hasUncommittedChanges(worktree), false);
  receiveWorkbenchMessage(job.jobId, "请开始处理这个需求。");
  await waitFor(() => getJob(job.jobId)?.workbenchNeedsInput && !getJob(job.jobId)?.workbenchTurnRunning, "restart cancelled task");
  assert.equal(getJob(job.jobId).workbenchReset, false);
  assert.equal(tapdStatus, "progressing");
  await writeFile(join(workspace, "user-uncommitted.txt"), "user work\n");
  receiveWorkbenchMessage(job.jobId, "三分钟，继续实现");
  await waitFor(() => getJob(job.jobId)?.status === "awaiting_merge" && !getJob(job.jobId)?.workbenchTurnRunning, "first implementation");
  const firstCommit = getJob(job.jobId).commitSha;
  assert.equal(getJob(job.jobId).worktreePath, worktree);
  assert.equal(git(workspace, "show", "HEAD:base.txt"), "base");
  assert.equal(await readFile(join(workspace, "user-uncommitted.txt"), "utf8"), "user work\n");
  receiveWorkbenchMessage(job.jobId, "再调整一下按钮文案");
  await waitFor(() => getJob(job.jobId)?.status === "awaiting_merge" && !getJob(job.jobId)?.workbenchTurnRunning, "follow-up implementation");
  assert.notEqual(getJob(job.jobId).commitSha, firstCommit); assert.equal(getJob(job.jobId).worktreePath, worktree);
  const gitService = getProjectGitService(job.projectId);
  const diff = await gitService.getCommitDiff(getJob(job.jobId).commitSha, undefined, getJob(job.jobId).workbenchBaseCommitSha);
  assert.deepEqual(diff.files.map(file => file.path).sort(), ["first.txt", "second.txt"]);
  receiveWorkbenchMessage(job.jobId, "慢速修改");
  await waitFor(async () => readFile(join(worktree, "partial.txt"), "utf8").then(() => true).catch(() => false), "partial write");
  pauseWorkbenchSession(job.jobId);
  await waitFor(() => !getJob(job.jobId)?.workbenchTurnRunning, "process stopped");
  assert.equal(getJob(job.jobId).worktreePath, worktree); assert.equal(await readFile(join(worktree, "partial.txt"), "utf8"), "preserved work\n");
  receiveWorkbenchMessage(job.jobId, "继续");
  await waitFor(() => getJob(job.jobId)?.status === "awaiting_merge" && !getJob(job.jobId)?.workbenchTurnRunning, "resume");
  const preservedCommit = getJob(job.jobId).commitSha;
  receiveWorkbenchMessage(job.jobId, "取消这次任务");
  await waitFor(() => getJob(job.jobId)?.workbenchPauseRequested && !getJob(job.jobId)?.workbenchTurnRunning, "cancel with existing code preserves changes");
  assert.equal(getJob(job.jobId).workbenchReset, false);
  assert.equal(getJob(job.jobId).commitSha, preservedCommit);
  assert.equal(await readFile(join(worktree, "partial.txt"), "utf8"), "preserved work\n");
  await confirmJobMerge(job.jobId);
  assert.equal(getJob(job.jobId).status, "completed");
  assert.equal(getJob(job.jobId).tapdSync.state, "failed");
  assert.equal(tapdStatus, "progressing");
  const mergedCommit = getJob(job.jobId).commitSha;
  failCompletion = false;
  await syncWorkbenchTask(job.jobId, "done");
  await syncWorkbenchTask(job.jobId, "done");
  assert.equal(completionWrites, 2);
  assert.equal(getJob(job.jobId).commitSha, mergedCommit, "sync retry must not merge again");
  assert.equal(getJob(job.jobId).tapdSync.state, "synced");
  assert.equal(tapdStatus, "done");
  receiveWorkbenchMessage(job.jobId, "取消这次任务");
  await waitFor(() => getJob(job.jobId)?.status === "completed" && !getJob(job.jobId)?.workbenchTurnRunning, "cancel cannot undo merged task");
  assert.equal(getJob(job.jobId).commitSha, mergedCommit);
  assert.equal(getJob(job.jobId).workbenchReset, false);
  assert.equal(tapdStatus, "done");
  assert.equal(git(workspace, "show", "HEAD:first.txt"), "task change");
  assert.equal(git(workspace, "show", "HEAD:partial.txt"), "preserved work");
  const historyLength = getJob(job.jobId).workbenchMessages.length;
  closeDatabase();
  assert.equal(getJob(job.jobId).workbenchMessages.length, historyLength);
  updateJob(job.jobId, { tapdSync: { target: "done", state: "pending" } });
  closeDatabase();
  initJobStore();
  assert.equal(getJob(job.jobId).tapdSync.state, "failed", "interrupted writeback must become retryable");
  await syncWorkbenchTask(job.jobId, "done");
  assert.equal(getJob(job.jobId).tapdSync.state, "synced");
  assert.equal(completionWrites, 2, "already completed TAPD task needs no further POST");
  console.log("PASS: real local Git/SQLite with fake CLI; natural clarification, automatic execution, same worktree across turns, accumulated Diff, pause preserves partial edits, resume, explicit merge, durable history, untouched user files.");
} finally { globalThis.fetch = originalFetch; closeDatabase(); process.chdir(originalDirectory); }
