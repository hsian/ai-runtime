import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { NextFunction, Request, Response } from "express";

import { config } from "../config.js";
import { registerOperationClient } from "./operationLog.js";

const CLIENT_ID_PATTERN = /^[0-9a-f-]{36}$/i;
const identityKey = Symbol("aiRuntimeClientIdentity");

export interface ClientIdentity {
  ownerId: string;
  remoteIp: string;
}

type IdentityRequest = Request & { [identityKey]?: ClientIdentity };

function loadCookieSecret(): string {
  if (config.CLIENT_COOKIE_SECRET?.trim()) return config.CLIENT_COOKIE_SECRET.trim();

  const secretPath = config.CLIENT_COOKIE_SECRET_FILE;
  if (existsSync(secretPath)) {
    const existing = readFileSync(secretPath, "utf8").trim();
    if (existing) return existing;
  }

  mkdirSync(dirname(secretPath), { recursive: true });
  const generated = randomBytes(48).toString("base64url");
  writeFileSync(secretPath, `${generated}\n`, { encoding: "utf8", mode: 0o600 });
  return generated;
}

const cookieSecret = loadCookieSecret();

function signOwnerId(ownerId: string): string {
  return createHmac("sha256", cookieSecret).update(ownerId).digest("base64url");
}

function encodeClientToken(ownerId: string): string {
  return `${ownerId}.${signOwnerId(ownerId)}`;
}

function verifyClientToken(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const separator = value.lastIndexOf(".");
  if (separator <= 0) return undefined;

  const ownerId = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  if (!CLIENT_ID_PATTERN.test(ownerId) || !signature) return undefined;

  const expected = Buffer.from(signOwnerId(ownerId));
  const received = Buffer.from(signature);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return undefined;
  return ownerId;
}

function parseCookie(header: string | undefined, name: string): string | undefined {
  for (const item of header?.split(";") ?? []) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    const key = item.slice(0, separator).trim();
    if (key !== name) continue;
    try {
      return decodeURIComponent(item.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function normalizeRemoteIp(value: string | undefined): string {
  const ip = value?.trim() || "unknown";
  if (ip === "::1") return "127.0.0.1";
  return ip.replace(/^::ffff:/, "");
}

export function clientIdentityMiddleware(req: Request, res: Response, next: NextFunction): void {
  const cookieValue = parseCookie(req.headers.cookie, config.CLIENT_COOKIE_NAME);
  let ownerId = verifyClientToken(cookieValue);

  if (!ownerId) {
    ownerId = randomUUID();
    const attributes = [
      `${config.CLIENT_COOKIE_NAME}=${encodeURIComponent(encodeClientToken(ownerId))}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      `Max-Age=${config.CLIENT_COOKIE_MAX_AGE_DAYS * 24 * 60 * 60}`,
    ];
    if (config.CLIENT_COOKIE_SECURE) attributes.push("Secure");
    res.append("Set-Cookie", attributes.join("; "));
  }

  (req as IdentityRequest)[identityKey] = {
    ownerId,
    remoteIp: normalizeRemoteIp(req.socket.remoteAddress),
  };
  registerOperationClient(ownerId, normalizeRemoteIp(req.socket.remoteAddress));
  next();
}

export function getClientIdentity(req: Request): ClientIdentity {
  return (
    (req as IdentityRequest)[identityKey] ?? {
      ownerId: "anonymous",
      remoteIp: normalizeRemoteIp(req.socket.remoteAddress),
    }
  );
}
