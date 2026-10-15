import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const directory = mkdtempSync(join(tmpdir(), "workbench-commands-"));
Object.assign(process.env, { DATABASE_PATH: join(directory, "test.sqlite"), UPLOAD_DIR: join(directory, "uploads"), GIT_ACCESS_TOKEN: "test-only", OPERATION_LOG_ENABLED: "false",
  TAPD_CLIENT_ID: "test", TAPD_CLIENT_SECRET: "test", TAPD_WORKSPACE_ID: "123", TAPD_WORKSPACES: "123:村财项目,456:产权项目", TAPD_API_BASE: "https://tapd.invalid" });
const { createUser } = await import("../../services/auth.js");
const { getDatabase, closeDatabase } = await import("../../services/database.js");
const { createJob, getJob, listJobs, updateJob } = await import("../../services/jobStore.js");
const { getWorkbenchPreferences } = await import("../../services/workbenchPreferences.js");
const { createWorkbenchCommands, WORKBENCH_COMMAND_HELP } = await import("./workbenchCommands.js");
const { loadTapdSnapshot } = await import("./tapdBridge.js");
const alice = createUser({ username: "alice", displayName: "前端甲", tapdOwnerName: "前端甲", password: "test-only", role: "member" });
const bob = createUser({ username: "bob", displayName: "前端乙", tapdOwnerName: "前端乙", password: "test-only", role: "member" });
const originalFetch = globalThis.fetch;
let owner = "前端甲;";
let bugOwner = "前端甲";
globalThis.fetch = async input => {
  const url = new URL(String(input));
  assert.equal(url.hostname, "tapd.invalid");
  if (url.pathname === "/tokens/request_token") return Response.json({ status: 1, data: { access_token: "test", expires_in: 3600 } });
  if (url.pathname === "/iterations") return Response.json({ status: 1, data: Array.from({ length: 20 }, (_, i) => ({ Iteration: { id: String(200 + i), name: i === 2 ? "[前端]九月研发" : `迭代-${i}`, status: "open" } })) });
  if (url.pathname === "/stories") return Response.json({ status: 1, data: [{ Story: { id: "41", name: "登录需求" } }] });
  if (url.pathname === "/bugs") return Response.json({ status: 1, data: [
    { Bug: { id: "21", name: "已关闭的 Bug", current_owner: "前端甲", status: "closed" } },
    { Bug: { id: "22", name: "待验收的 Bug", current_owner: bugOwner, reporter: "测试甲", status: "resolved" } },
  ].filter(record => !url.searchParams.get("id") || record.Bug.id === url.searchParams.get("id")) });
  if (url.pathname === "/tasks") {
    const front = { id: "11", name: "前端 - 登录需求", owner, status: "open", story_id: "41" };
    return Response.json({ status: 1, data: url.searchParams.get("id") ? [{ Task: front }] : [
      { Task: { id: "14", name: "前端 - 已完成任务", owner: "前端甲", status: "done", story_id: "41" } },
      { Task: front }, { Task: { id: "12", name: "后端 - 登录接口", owner: "后端甲", status: "done", story_id: "41" } },
      { Task: { id: "13", name: "前端 - 别人的任务", owner: "其他人", status: "open", story_id: "41" } },
    ] });
  }
  throw new Error("unexpected API");
};
after(() => { globalThis.fetch = originalFetch; closeDatabase(); rmSync(directory, { recursive: true, force: true }); });
const received: Array<{ id: string; text: string }> = [];
const merged: string[] = [];
const commands = createWorkbenchCommands({ botId: "test", secret: "test", projectId: "b2b-composite", codeAllowedUserIds: ["alice-wecom"], workbenchUrl: "https://ai.example/workbench" },
  sender => sender === "alice-wecom" ? { id: alice.id, username: "alice", tapd_owner_name: "前端甲" }
    : sender === "bob-wecom" ? { id: bob.id, username: "bob", tapd_owner_name: "前端乙" } : undefined,
  (id, text) => { received.push({ id, text }); },
  (async url => ({ snapshotId: randomUUID(), context: { workspaceId: "123", storyId: "41", itemId: "41", itemType: "story", title: "登录需求", description: "增加登录入口", url, commentCount: 0, fetchedAt: new Date().toISOString() }, attachments: [], warnings: [] })) as typeof loadTapdSnapshot,
  { diff: async job => ({ commitSha: job.commitSha!, files: [], additions: 2, deletions: 1, patch: "" }), enqueueMerge: id => { merged.push(id); } });

test("help prints every command; unknown syntax and groups never invoke the model or expose tasks", async () => {
  assert.equal(await commands("unknown", "/help"), WORKBENCH_COMMAND_HELP);
  assert.match((await commands("unknown", "/heip"))!, /未知工作台命令/);
  for (const command of ["use", "list", "analyze", "start", "reply", "review", "done"]) assert.ok(WORKBENCH_COMMAND_HELP.includes(`/${command}`));
  assert.match((await commands("alice-wecom", "/install T1"))!, /未知/);
  assert.match((await commands("alice-wecom", "/list", { group: true }))!, /私聊/);
  assert.equal(await commands("alice-wecom", "普通聊天"), undefined);
  assert.match((await commands("alice-wecom", "-start T1"))!, /已改为.*前缀/);
  assert.match((await commands("alice-wecom", "/start"))!, /用法：\/start/);
  assert.equal(received.length, 0);
});

test("project/iteration choices support pages/search, stable IDs, and shared account preferences", async () => {
  assert.match((await commands("alice-wecom", "/use"))!, /P1.*村财项目/);
  assert.match((await commands("alice-wecom", "/use P1"))!, /I1.*迭代-0/);
  assert.match((await commands("alice-wecom", "/use next"))!, /I11.*迭代-10/);
  assert.match((await commands("alice-wecom", "/use 前端"))!, /I3.*九月研发/);
  assert.match((await commands("alice-wecom", "/use I3"))!, /已选择/);
  assert.deepEqual(getWorkbenchPreferences(alice.id), { workspaceId: "123", iterationId: "202" });
  assert.deepEqual(getWorkbenchPreferences(bob.id), {});
  await commands("alice-wecom", "/use iter");
  await commands("alice-wecom", "/use next");
  assert.match((await commands("alice-wecom", "/use p1 i17"))!, /村财项目.*迭代-16/);
  assert.deepEqual(getWorkbenchPreferences(alice.id), { workspaceId: "123", iterationId: "216" });
  for (const invalid of ["/use p2 i17", "/use p1 i999", "/use i17 p1", "/use p1 i17 extra"]) {
    assert.match((await commands("alice-wecom", invalid))!, /无效|其他项目|用法/);
    assert.deepEqual(getWorkbenchPreferences(alice.id), { workspaceId: "123", iterationId: "216" });
  }
  await commands("alice-wecom", "/use P2");
  assert.match((await commands("alice-wecom", "/use p1 i3"))!, /村财项目.*九月研发/);
  assert.deepEqual(getWorkbenchPreferences(alice.id), { workspaceId: "123", iterationId: "202" });
});

test("list only includes assigned tasks; analyze/start/reply use one account-owned job and retain its engine", async () => {
  const list = (await commands("alice-wecom", "/list"))!;
  assert.match(list, /T1.*前端 - 登录需求/);
  assert.match(list, /后端已就绪 1\/1/);
  assert.doesNotMatch(list, /别人的任务/);
  assert.doesNotMatch(list, /已完成任务|已关闭的 Bug/);
  assert.match(list, /待验收的 Bug/);
  assert.match((await commands("alice-wecom", "/analyze T1"))!, /已开始分析，不修改代码/);
  const job = listJobs().find(item => item.workbenchUserId === alice.id)!;
  assert.equal(job.workbenchAnalysisOnly, true);
  assert.equal(job.tapdTask?.taskId, "11");
  assert.equal(job.tapdOperator, "前端甲");
  await commands("alice-wecom", "/reply T1 接口字段已确认");
  assert.equal(getJob(job.jobId)?.workbenchAnalysisOnly, true);
  updateJob(job.jobId, { agentProvider: "claude" });
  await commands("alice-wecom", "/start T1");
  assert.equal(getJob(job.jobId)?.workbenchAnalysisOnly, false);
  assert.equal(getJob(job.jobId)?.agentProvider, "claude");
  assert.ok(received.every(item => item.id === job.jobId));
  assert.match((await commands("bob-wecom", "/start T1"))!, /编号无效/);
  const before = received.length;
  owner = "其他人;";
  assert.match((await commands("alice-wecom", "/start T1"))!, /负责人已变化/);
  assert.equal(received.length, before); owner = "前端甲;";
});

test("Review and completion bind confirmation to exact commit; changed/stale/wrong codes never merge", async () => {
  const job = listJobs().find(item => item.workbenchUserId === alice.id)!;
  updateJob(job.jobId, { status: "awaiting_merge", commitSha: "code-v1", branch: "test-branch", worktreePath: "/test-only", workbenchHasCodeChanges: true, workbenchTurnRunning: false });
  assert.match((await commands("alice-wecom", "/review T1"))!, /查看完整 Diff/);
  const first = (await commands("alice-wecom", "/done T1"))!;
  const code = /\/done T1 ([a-f0-9]+)/.exec(first)![1];
  assert.match((await commands("alice-wecom", "/done T1 wrong"))!, /确认码无效/);
  updateJob(job.jobId, { commitSha: "code-v2" });
  assert.match((await commands("alice-wecom", `/done T1 ${code}`))!, /代码已更新/);
  assert.deepEqual(merged, []);
  const next = (await commands("alice-wecom", "/done T1"))!;
  const confirmation = /\/done T1 ([a-f0-9]+)/.exec(next)![1];
  await commands("alice-wecom", `/done T1 ${confirmation}`);
  assert.deepEqual(merged, [job.jobId]);
  await commands("alice-wecom", `/done T1 ${confirmation}`);
  assert.equal(merged.length, 1);
  assert.equal((getDatabase().prepare("SELECT COUNT(*) AS count FROM workbench_merge_confirmations").get() as { count: number }).count, 0);
  assert.equal(getJob(job.jobId)?.status, "pending");
});

test("Bug completion confirmation describes reporter handoff, and repeated completion after handoff does not merge again", async () => {
  const list = (await commands("alice-wecom", "/list"))!;
  const label = /(T\d+)\s+待验收的 Bug/.exec(list)![1];
  const job = createJob({ prompt: "Bug fix", ownerId: `workbench:${alice.id}`, projectId: "b2b-composite", conversationId: "bug-test", taskMode: "code", tapdContext: { workspaceId: "123", itemType: "bug", itemId: "22", title: "待验收的 Bug", description: "Fix", url: "https://tapd.invalid/bug/22", fetchedAt: new Date().toISOString() } });
  updateJob(job.jobId, { workbenchSession: true, workbenchUserId: alice.id, tapdOperator: "前端甲", status: "awaiting_merge", commitSha: "bug-v1", branch: "bug-branch", worktreePath: "/test-only", workbenchHasCodeChanges: true });
  const confirmation = (await commands("alice-wecom", `/done ${label}`))!;
  assert.match(confirmation, /已解决.*创建人回归/);
  assert.doesNotMatch(confirmation, /同步 TAPD 已完成/);
  const code = /\/done T\d+ ([a-f0-9]+)/.exec(confirmation)![1];
  assert.match((await commands("alice-wecom", `/done ${label} ${code}`))!, /已解决.*创建人回归/);
  assert.equal(merged.filter(id => id === job.jobId).length, 1);
  updateJob(job.jobId, { status: "completed", mergedToDefaultAt: new Date().toISOString(), tapdSync: { target: "resolved", state: "synced" } });
  bugOwner = "测试甲";
  assert.match((await commands("alice-wecom", `/done ${label}`))!, /已解决并转回创建人/);
  assert.equal(merged.filter(id => id === job.jobId).length, 1);
  assert.match((await commands("alice-wecom", `/start ${label}`))!, /负责人已变化/);
});
