import { appendFile, mkdir, readFile, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

import { config } from "../config.js";

export type OperationLogStatus = "started" | "success" | "failed" | "cancelled";

export interface OperationLogEntry {
  action: string;
  status: OperationLogStatus;
  jobId?: string;
  ownerId?: string;
  remoteIp?: string;
  mode?: "plan" | "question" | "execute";
  engine?: string;
  durationMs?: number;
  branch?: string;
  commitSha?: string;
  targetBranch?: string;
  attachmentCount?: number;
  workspaceId?: string;
  iterationId?: string;
  tapdItemId?: string;
  message?: string;
  error?: string;
}

const LOG_FILE_PATTERN = /^operations-\d{4}-\d{2}-\d{2}(?:-\d+)?\.jsonl$/;
let writeQueue = Promise.resolve();
const clientIps = new Map<string, string>();

export function registerOperationClient(ownerId: string, remoteIp: string): void {
  clientIps.set(ownerId, remoteIp);
}

function localDateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function redact(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/([?&](?:access_token|token|api_key|apikey|secret|password)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/\b(?:ghp_|github_pat_|glpat-|sk-)[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
    .slice(0, 2_000);
}

function sanitizeEntry(entry: OperationLogEntry): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(entry)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, typeof value === "string" ? redact(value) : value])
  );
}

async function appendEntry(entry: OperationLogEntry): Promise<void> {
  await mkdir(config.OPERATION_LOG_DIR, { recursive: true });
  const dateKey = localDateKey();
  const maxBytes = config.OPERATION_LOG_MAX_FILE_MB * 1024 * 1024;
  let part = 1;
  let filePath: string;
  while (true) {
    const suffix = part === 1 ? "" : `-${part}`;
    filePath = join(config.OPERATION_LOG_DIR, `operations-${dateKey}${suffix}.jsonl`);
    try {
      const info = await stat(filePath);
      if (info.size < maxBytes) break;
      part += 1;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") break;
      throw err;
    }
  }
  const line = JSON.stringify({
    time: new Date().toISOString(),
    ...sanitizeEntry({
      ...entry,
      remoteIp: entry.remoteIp ?? (entry.ownerId ? clientIps.get(entry.ownerId) : undefined),
    }),
  });
  await appendFile(filePath, `${line}\n`, "utf8");
}

export function logOperation(entry: OperationLogEntry): void {
  if (!config.OPERATION_LOG_ENABLED) return;

  writeQueue = writeQueue
    .then(() => appendEntry(entry))
    .catch((err) => {
      console.warn(
        "[OperationLog] 写入操作日志失败:",
        err instanceof Error ? err.message : String(err)
      );
    });
}

export async function cleanupExpiredOperationLogs(): Promise<void> {
  if (!config.OPERATION_LOG_ENABLED) return;

  await mkdir(config.OPERATION_LOG_DIR, { recursive: true });
  const cutoff = Date.now() - config.OPERATION_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const names = await readdir(config.OPERATION_LOG_DIR);

  await Promise.all(
    names.filter((name) => LOG_FILE_PATTERN.test(name)).map(async (name) => {
      const filePath = join(config.OPERATION_LOG_DIR, name);
      const info = await stat(filePath);
      if (info.mtimeMs < cutoff) await unlink(filePath);
    })
  );
}

export async function listOperationLogDates(): Promise<string[]> {
  if (!config.OPERATION_LOG_ENABLED) return [];
  await mkdir(config.OPERATION_LOG_DIR, { recursive: true });
  const names = await readdir(config.OPERATION_LOG_DIR);
  return [...new Set(
    names
      .filter((name) => LOG_FILE_PATTERN.test(name))
      .map((name) => /^operations-(\d{4}-\d{2}-\d{2})/.exec(name)?.[1])
      .filter((value): value is string => Boolean(value))
  )].sort().reverse();
}

export async function readOperationLogs(options: {
  date: string;
  ownerId?: string;
  limit?: number;
}): Promise<Array<Record<string, unknown>>> {
  if (!config.OPERATION_LOG_ENABLED || !/^\d{4}-\d{2}-\d{2}$/.test(options.date)) return [];
  await mkdir(config.OPERATION_LOG_DIR, { recursive: true });
  const names = (await readdir(config.OPERATION_LOG_DIR))
    .filter((name) => name === `operations-${options.date}.jsonl` || name.startsWith(`operations-${options.date}-`))
    .filter((name) => LOG_FILE_PATTERN.test(name))
    .sort();
  const entries: Array<Record<string, unknown>> = [];
  for (const name of names) {
    const content = await readFile(join(config.OPERATION_LOG_DIR, name), "utf8");
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (options.ownerId && entry.ownerId !== options.ownerId) continue;
        entries.push(entry);
      } catch {
        // Ignore a partially written or malformed line without affecting other logs.
      }
    }
  }
  const limit = Math.min(Math.max(options.limit ?? 300, 1), 1000);
  return entries
    .sort((left, right) => String(right.time ?? "").localeCompare(String(left.time ?? "")))
    .slice(0, limit);
}
