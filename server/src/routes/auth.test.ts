import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import express from "express";

const directory = mkdtempSync(join(tmpdir(), "ai-runtime-auth-test-"));
process.env.DATABASE_PATH = join(directory, "auth.sqlite");

const [{ authRouter, adminRouter }, { authMiddleware, createUser }, { initDatabase, closeDatabase }] = await Promise.all([
  import("./auth.js"), import("../services/auth.js"), import("../services/database.js"),
]);
initDatabase();
createUser({ username: "admin", displayName: "Admin", tapdOwnerName: "Admin", password: "initial-password-123", role: "admin" });
const app = express();
app.use(express.json());
app.use(authMiddleware);
app.use("/api/auth", authRouter);
app.use("/api/admin", adminRouter);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Server did not bind");
const base = `http://127.0.0.1:${address.port}`;

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDatabase();
  if (directory.startsWith(tmpdir())) rmSync(directory, { recursive: true, force: true });
});

test("admin APIs require a session and first password change", async () => {
  const anonymous = await fetch(`${base}/api/admin/users`);
  assert.equal(anonymous.status, 401);
  const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "initial-password-123" }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).find((value) => value.startsWith("ai_runtime_session=") && value.length > "ai_runtime_session=".length);
  assert.ok(cookie);
  const beforeChange = await fetch(`${base}/api/admin/users`, { headers: { Cookie: cookie } });
  assert.equal(beforeChange.status, 403);
  const tooShort = await fetch(`${base}/api/auth/change-password`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ currentPassword: "initial-password-123", newPassword: "12345" }) });
  assert.equal(tooShort.status, 400);
  const change = await fetch(`${base}/api/auth/change-password`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ currentPassword: "initial-password-123", newPassword: "abcdef" }) });
  assert.equal(change.status, 200);
  const newCookie = change.headers.getSetCookie().map((value) => value.split(";")[0]).find((value) => value.startsWith("ai_runtime_session=") && value.length > "ai_runtime_session=".length);
  assert.ok(newCookie);
  const authorized = await fetch(`${base}/api/admin/users`, { headers: { Cookie: newCookie } });
  assert.equal(authorized.status, 200);
  const create = await fetch(`${base}/api/admin/users`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: newCookie }, body: JSON.stringify({ username: "member", displayName: "Member", tapdOwnerName: "Member", role: "member" }) });
  assert.equal(create.status, 201);
  const { initialPassword } = await create.json() as { initialPassword: string };
  const memberLogin = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "member", password: initialPassword }) });
  const memberCookie = memberLogin.headers.getSetCookie().map((value) => value.split(";")[0]).find((value) => value.startsWith("ai_runtime_session=") && value.length > "ai_runtime_session=".length);
  assert.ok(memberCookie);
  const memberChange = await fetch(`${base}/api/auth/change-password`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: memberCookie }, body: JSON.stringify({ currentPassword: initialPassword, newPassword: "1234567" }) });
  assert.equal(memberChange.status, 200);
  const memberSession = memberChange.headers.getSetCookie().map((value) => value.split(";")[0]).find((value) => value.startsWith("ai_runtime_session=") && value.length > "ai_runtime_session=".length);
  assert.ok(memberSession);
  const forbidden = await fetch(`${base}/api/admin/users`, { headers: { Cookie: memberSession } });
  assert.equal(forbidden.status, 403);
});
