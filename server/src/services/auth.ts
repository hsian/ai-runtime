import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

import { config } from "../config.js";
import { getDatabase } from "./database.js";

export const permissions = {
  admin: ["work_hours.view", "work_hours.apply", "users.manage"],
  member: ["work_hours.view", "work_hours.apply"],
} as const;

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  tapdOwnerName: string;
  role: "admin" | "member";
  permissions: string[];
  mustChangePassword: boolean;
}

type UserRow = {
  id: string; username: string; display_name: string; tapd_owner_name: string;
  password_hash: string; role: "admin" | "member"; enabled: number; must_change_password: number;
};

const authKey = Symbol("authUser");
type AuthRequest = Request & { [authKey]?: AuthUser };
const cookieName = "ai_runtime_session";
const sessionDays = 7;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt:${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [, salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const actual = scryptSync(password, Buffer.from(salt, "hex"), 64);
  const expected = Buffer.from(hash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function getUserByName(username: string): UserRow | undefined {
  return getDatabase().prepare("SELECT * FROM users WHERE username = ?").get(username) as UserRow | undefined;
}

export function publicUser(row: UserRow): AuthUser {
  return {
    id: row.id, username: row.username, displayName: row.display_name,
    tapdOwnerName: row.tapd_owner_name, role: row.role,
    permissions: [...permissions[row.role]], mustChangePassword: Boolean(row.must_change_password),
  };
}

export function createUser(input: { username: string; displayName: string; tapdOwnerName: string; password: string; role: "admin" | "member" }): AuthUser {
  const id = randomUUID();
  getDatabase().prepare(`INSERT INTO users (id, username, display_name, tapd_owner_name, password_hash, role, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, input.username, input.displayName, input.tapdOwnerName, hashPassword(input.password), input.role, new Date().toISOString());
  return publicUser(getDatabase().prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow);
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function cookie(req: Request): string | undefined {
  const raw = req.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`));
  return raw?.slice(cookieName.length + 1);
}

function cookieOptions(maxAge: number): string {
  return `${cookieName}=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${config.CLIENT_COOKIE_SECURE ? "; Secure" : ""}`;
}

export function createSession(res: Response, userId: string): void {
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const expires = new Date(now.getTime() + sessionDays * 86400_000);
  getDatabase().prepare("INSERT INTO auth_sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .run(tokenHash(token), userId, expires.toISOString(), now.toISOString());
  res.append("Set-Cookie", cookieOptions(sessionDays * 86400).replace(`${cookieName}=;`, `${cookieName}=${token};`));
}

export function clearSession(req: Request, res: Response): void {
  const token = cookie(req);
  if (token) getDatabase().prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(tokenHash(token));
  res.append("Set-Cookie", cookieOptions(0));
}

export function getAuthUser(req: Request): AuthUser | undefined {
  return (req as AuthRequest)[authKey];
}

export function authMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const token = cookie(req);
  if (token) {
    const row = getDatabase().prepare(`SELECT users.* FROM auth_sessions
      JOIN users ON users.id = auth_sessions.user_id
      WHERE token_hash = ? AND expires_at > ? AND users.enabled = 1`)
      .get(tokenHash(token), new Date().toISOString()) as UserRow | undefined;
    if (row) (req as AuthRequest)[authKey] = publicUser(row);
  }
  next();
}

export function requirePermission(permission: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = getAuthUser(req);
    if (!user) { res.status(401).json({ error: "请先登录" }); return; }
    if (user.mustChangePassword && req.path !== "/change-password") {
      res.status(403).json({ error: "请先修改初始密码" }); return;
    }
    if (!user.permissions.includes(permission)) { res.status(403).json({ error: "没有访问权限" }); return; }
    next();
  };
}

export function requireSameOrigin(req: Request, res: Response, next: NextFunction): void {
  const origin = req.get("origin");
  const host = req.get("host");
  if (origin && host && new URL(origin).host !== host) {
    res.status(403).json({ error: "请求来源不受信任" }); return;
  }
  next();
}
