import { randomBytes } from "node:crypto";
import { Router } from "express";
import { z } from "zod";

import { getDatabase } from "../services/database.js";
import { clearSession, createSession, createUser, getAuthUser, getUserByName, hashPassword, publicUser, requirePermission, verifyPassword } from "../services/auth.js";

export const authRouter = Router();
export const adminRouter = Router();
const loginAttempts = new Map<string, { count: number; until: number }>();
const username = z.string().trim().min(3).max(40).regex(/^[a-zA-Z0-9._-]+$/);
const password = z.string().min(6).max(128);

authRouter.get("/me", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ user: getAuthUser(req) ?? null });
});

authRouter.post("/login", (req, res) => {
  const input = z.object({ username, password: z.string() }).safeParse(req.body);
  if (!input.success) { res.status(400).json({ error: "请输入账号和密码" }); return; }
  const key = `${req.socket.remoteAddress}:${input.data.username}`;
  const attempt = loginAttempts.get(key);
  if (attempt && attempt.count >= 5 && attempt.until > Date.now()) {
    res.status(429).json({ error: "尝试次数过多，请 15 分钟后重试" }); return;
  }
  const row = getUserByName(input.data.username);
  if (!row || !row.enabled || !verifyPassword(input.data.password, row.password_hash)) {
    loginAttempts.set(key, { count: (attempt?.until && attempt.until > Date.now() ? attempt.count : 0) + 1, until: Date.now() + 15 * 60_000 });
    res.status(401).json({ error: "账号或密码错误" }); return;
  }
  loginAttempts.delete(key);
  clearSession(req, res);
  createSession(res, row.id);
  res.json({ user: publicUser(row) });
});

authRouter.post("/logout", (req, res) => {
  clearSession(req, res);
  res.json({ ok: true });
});

authRouter.post("/change-password", (req, res) => {
  const user = getAuthUser(req);
  if (!user) { res.status(401).json({ error: "请先登录" }); return; }
  const input = z.object({ currentPassword: z.string(), newPassword: password }).safeParse(req.body);
  if (!input.success) { res.status(400).json({ error: "新密码至少 6 位" }); return; }
  const row = getUserByName(user.username)!;
  if (!verifyPassword(input.data.currentPassword, row.password_hash)) {
    res.status(400).json({ error: "原密码错误" }); return;
  }
  getDatabase().prepare("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?")
    .run(hashPassword(input.data.newPassword), user.id);
  getDatabase().prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(user.id);
  clearSession(req, res);
  createSession(res, user.id);
  res.json({ user: { ...user, mustChangePassword: false } });
});

adminRouter.use(requirePermission("users.manage"));
adminRouter.get("/users", (_req, res) => {
  const rows = getDatabase().prepare("SELECT id, username, display_name, tapd_owner_name, role, enabled, must_change_password, created_at FROM users ORDER BY created_at DESC").all();
  res.json({ users: rows });
});

adminRouter.post("/users", (req, res) => {
  const input = z.object({ username, displayName: z.string().trim().min(1).max(80), tapdOwnerName: z.string().trim().min(1).max(80), role: z.enum(["admin", "member"]).default("member") }).safeParse(req.body);
  if (!input.success) { res.status(400).json({ error: "账号信息不完整" }); return; }
  if (getUserByName(input.data.username)) { res.status(409).json({ error: "账号已存在" }); return; }
  const initialPassword = randomBytes(18).toString("base64url");
  const user = createUser({ ...input.data, password: initialPassword });
  res.status(201).json({ user, initialPassword });
});

adminRouter.patch("/users/:id", (req, res) => {
  const input = z.object({ displayName: z.string().trim().min(1).max(80), tapdOwnerName: z.string().trim().min(1).max(80), role: z.enum(["admin", "member"]), enabled: z.boolean() }).safeParse(req.body);
  if (!input.success) { res.status(400).json({ error: "账号信息无效" }); return; }
  if (req.params.id === getAuthUser(req)?.id && (!input.data.enabled || input.data.role !== "admin")) {
    res.status(400).json({ error: "不能停用或降级当前管理员" }); return;
  }
  const result = getDatabase().prepare("UPDATE users SET display_name = ?, tapd_owner_name = ?, role = ?, enabled = ? WHERE id = ?")
    .run(input.data.displayName, input.data.tapdOwnerName, input.data.role, Number(input.data.enabled), req.params.id);
  if (!result.changes) { res.status(404).json({ error: "账号不存在" }); return; }
  if (!input.data.enabled) getDatabase().prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(req.params.id);
  res.json({ ok: true });
});

adminRouter.post("/users/:id/reset-password", (req, res) => {
  const row = getDatabase().prepare("SELECT id FROM users WHERE id = ?").get(req.params.id);
  if (!row) { res.status(404).json({ error: "账号不存在" }); return; }
  const initialPassword = randomBytes(18).toString("base64url");
  getDatabase().prepare("UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?")
    .run(hashPassword(initialPassword), req.params.id);
  getDatabase().prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(req.params.id);
  res.json({ initialPassword });
});
