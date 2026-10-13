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
