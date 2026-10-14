import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
const directory = mkdtempSync(join(tmpdir(), "workbench-identity-test-"));
process.env.DATABASE_PATH = join(directory, "test.sqlite");
process.env.CLIENT_COOKIE_SECRET = "test-only-browser-cookie";
process.env.GIT_ACCESS_TOKEN = "test-only";
process.env.OPERATION_LOG_ENABLED = "false";
const { initDatabase, closeDatabase } = await import("../services/database.js");
const { authMiddleware, createUser } = await import("../services/auth.js");
const { clientIdentityMiddleware, getClientIdentity } = await import("../services/clientIdentity.js");
const { authRouter } = await import("./auth.js");
const { jobsRouter } = await import("./jobs.js");
const { createJob, updateJob } = await import("../services/jobStore.js");
initDatabase();
const alice = createUser({ username: "alice", displayName: "Alice", tapdOwnerName: "Alice", password: "test-password", role: "member" });
createUser({ username: "bobby", displayName: "Bob", tapdOwnerName: "Bob", password: "test-password", role: "member" });
const app = express(); app.use(express.json()); app.use(authMiddleware); app.use(clientIdentityMiddleware);
app.use("/api/auth", authRouter); app.use("/api/jobs", jobsRouter);
app.get("/identity", (req, res) => res.json(getClientIdentity(req)));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>(resolve => server.once("listening", resolve));
const address = server.address(); if (!address || typeof address === "string") throw Error("missing port");
const base = `http://127.0.0.1:${address.port}`;
after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); closeDatabase(); rmSync(directory, { recursive: true, force: true }); });
async function login(name: string) {
  const response = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: name, password: "test-password" }) });
  assert.equal(response.status, 200);
  return response.headers.getSetCookie().map(value => value.split(";")[0]).find(value => value.startsWith("ai_runtime_session=") && value.length > "ai_runtime_session=".length)!;
}
test("same browser with another login cannot read or continue another user's workbench job", async () => {
  const browser = await fetch(`${base}/identity`);
  const browserCookie = browser.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
  const owner = (await browser.json() as { ownerId: string }).ownerId;
  const job = createJob({ prompt: "private workbench task", ownerId: owner, projectId: "b2b-composite" });
  updateJob(job.jobId, { workbenchSession: true, workbenchUserId: alice.id, status: "awaiting_input" });
  const ownCookie = `${browserCookie}; ${await login("alice")}`;
  const otherCookie = `${browserCookie}; ${await login("bobby")}`;
  assert.equal((await fetch(`${base}/api/jobs/${job.jobId}`, { headers: { Cookie: ownCookie } })).status, 200);
  assert.equal((await fetch(`${base}/api/jobs/${job.jobId}`, { headers: { Cookie: otherCookie } })).status, 404);
  const otherList = await fetch(`${base}/api/jobs`, { headers: { Cookie: otherCookie } });
  assert.equal((await otherList.json() as { jobs: { jobId: string }[] }).jobs.some(item => item.jobId === job.jobId), false);
  assert.equal((await fetch(`${base}/api/jobs/${job.jobId}/message`, { method: "POST", headers: { Cookie: otherCookie, "Content-Type": "application/json" }, body: JSON.stringify({ message: "继续" }) })).status, 404);
  // The same account on another browser still owns the task.
  assert.equal((await fetch(`${base}/api/jobs/${job.jobId}`, { headers: { Cookie: await login("alice") } })).status, 200);
});
test("anonymous workbench creation cannot spoof the logged in account", async () => {
  const response = await fetch(`${base}/api/jobs/workbench`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: "spoof", workbenchUserId: alice.id }) });
  assert.equal(response.status, 401);
});

test("conversation deletion blocks a workbench actor still winding down and denies another account", async () => {
  const job = createJob({ prompt: "deletion fixture", ownerId: "account-owned", projectId: "b2b-composite", conversationId: "delete-fixture" });
  updateJob(job.jobId, { workbenchSession: true, workbenchUserId: alice.id, status: "awaiting_input", workbenchTurnRunning: true });
  const path = `${base}/api/jobs/conversation/delete-fixture?projectId=b2b-composite`;
  assert.equal((await fetch(path, { method: "DELETE", headers: { Cookie: await login("alice") } })).status, 409);
  assert.equal((await fetch(path, { method: "DELETE", headers: { Cookie: await login("bobby") } })).status, 404);
});

test("shared workbench scope is persisted per authenticated account and rejects cross-site writes", async () => {
  const ownCookie = await login("alice"); const otherCookie = await login("bobby");
  const saved = await fetch(`${base}/api/auth/workbench`, { method: "PUT", headers: { Cookie: ownCookie, Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ workspaceId: "123", iterationId: "200" }) });
  assert.equal(saved.status, 200);
  assert.deepEqual(await (await fetch(`${base}/api/auth/workbench`, { headers: { Cookie: ownCookie } })).json(), { workspaceId: "123", iterationId: "200" });
  assert.deepEqual(await (await fetch(`${base}/api/auth/workbench`, { headers: { Cookie: otherCookie } })).json(), {});
  assert.equal((await fetch(`${base}/api/auth/workbench`, { method: "PUT", headers: { Cookie: ownCookie, Origin: "https://other.invalid", "Content-Type": "application/json" }, body: JSON.stringify({ workspaceId: "456" }) })).status, 403);
  assert.equal((await fetch(`${base}/api/auth/workbench`)).status, 401);
});

test("engine switching is account-scoped, validates the provider, blocks running turns and preserves task workspace/history", async () => {
  const job = createJob({ prompt: "engine fixture", ownerId: "account-owned", projectId: "b2b-composite", agentProvider: "codex", conversationId: "engine-fixture" });
  updateJob(job.jobId, { workbenchSession: true, workbenchUserId: alice.id, status: "awaiting_input", worktreePath: "/test-worktree-not-real", branch: "engine-branch", workbenchPauseRequested: true,
    workbenchMessages: [{ id: "u1", role: "user", text: "上下文保留", createdAt: new Date().toISOString() }] });
  const ownCookie = await login("alice"); const otherCookie = await login("bobby");
  const patch = (cookie: string, provider: string) => fetch(`${base}/api/jobs/${job.jobId}/engine`, { method: "PATCH", headers: { Cookie: cookie, Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ agentProvider: provider }) });
  assert.equal((await patch(otherCookie, "claude")).status, 404);
  assert.equal((await patch(ownCookie, "invalid")).status, 400);
  updateJob(job.jobId, { workbenchTurnRunning: true });
  assert.equal((await patch(ownCookie, "claude")).status, 409);
  updateJob(job.jobId, { workbenchTurnRunning: false });
  assert.equal((await patch(ownCookie, "claude")).status, 200);
  const { getJob } = await import("../services/jobStore.js");
  const latest = getJob(job.jobId)!;
  assert.equal(latest.agentProvider, "claude");
  assert.equal(latest.worktreePath, "/test-worktree-not-real");
  assert.equal(latest.branch, "engine-branch");
  assert.equal(latest.conversationId, "engine-fixture");
  assert.equal(latest.workbenchMessages?.[0].text, "上下文保留");
});
