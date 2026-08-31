import { v4 as uuidv4 } from "uuid";

import type { ConversationHistoryMessage, Job, JobRequest, JobStatus } from "../types.js";
import { getDatabase, initDatabase } from "./database.js";

const MAX_HISTORY_JOBS = 10;
const MAX_HISTORY_CHARS = 16_000;
const INTERRUPTED_STATUSES: JobStatus[] = ["planning", "pending", "running"];

interface JobRow {
  data: string;
}

export interface ConversationContextStats {
  usedJobs: number;
  maxJobs: number;
  usedChars: number;
  maxChars: number;
}

function parseJob(row: JobRow | undefined): Job | undefined {
  if (!row) return undefined;
  return JSON.parse(row.data) as Job;
}

function persistJob(job: Job): void {
  getDatabase()
    .prepare(`
      INSERT INTO jobs (
        job_id, owner_id, conversation_id, status, created_at, updated_at, data
      ) VALUES (
        @jobId, @ownerId, @conversationId, @status, @createdAt, @updatedAt, @data
      )
      ON CONFLICT(job_id) DO UPDATE SET
        owner_id = excluded.owner_id,
        conversation_id = excluded.conversation_id,
        status = excluded.status,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        data = excluded.data
    `)
    .run({
      jobId: job.jobId,
      ownerId: job.ownerId,
      conversationId: job.conversationId ?? null,
      status: job.status,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      data: JSON.stringify(job),
    });
}

function buildConversationHistory(request: JobRequest): ConversationHistoryMessage[] | undefined {
  if (!request.conversationId) return undefined;

  const rows = getDatabase()
    .prepare(`
      SELECT data
      FROM jobs
      WHERE owner_id = ?
        AND conversation_id = ?
        AND status IN ('completed', 'awaiting_confirm', 'awaiting_input', 'awaiting_merge')
      ORDER BY created_at DESC
      LIMIT ?
    `)
    .all(request.ownerId ?? "anonymous", request.conversationId, MAX_HISTORY_JOBS) as JobRow[];
  const related = rows.map((row) => parseJob(row)!).reverse();

  const turns: ConversationHistoryMessage[][] = [];
  for (const job of related) {
    const plan = job.planSummary?.trim();
    const result = job.message?.trim();
    const answer = [plan ? `已确认方案：\n${plan}` : "", result ? `任务结果：\n${result}` : ""]
      .filter(Boolean)
      .join("\n\n");
    if (!answer) continue;
    turns.push([
      { role: "user", content: job.prompt },
      { role: "assistant", content: answer },
    ]);
  }

  let total = 0;
  const limited: ConversationHistoryMessage[] = [];
  for (const turn of turns.reverse()) {
    const turnLength = turn.reduce((sum, message) => sum + message.content.length, 0);
    if (limited.length > 0 && total + turnLength > MAX_HISTORY_CHARS) break;
    limited.unshift(...turn);
    total += turnLength;
  }
  return limited;
}

export function getConversationContextStats(
  ownerId: string,
  conversationId: string
): ConversationContextStats {
  const history = buildConversationHistory({ prompt: "", ownerId, conversationId }) ?? [];
  return {
    usedJobs: history.filter((message) => message.role === "user").length,
    maxJobs: MAX_HISTORY_JOBS,
    usedChars: history.reduce((sum, message) => sum + message.content.length, 0),
    maxChars: MAX_HISTORY_CHARS,
  };
}

export function initJobStore(): void {
  initDatabase();
  const placeholders = INTERRUPTED_STATUSES.map(() => "?").join(", ");
  const rows = getDatabase()
    .prepare(`SELECT data FROM jobs WHERE status IN (${placeholders})`)
    .all(...INTERRUPTED_STATUSES) as JobRow[];
  const now = new Date().toISOString();
  const markInterrupted = getDatabase().transaction(() => {
    for (const row of rows) {
      const job = parseJob(row)!;
      persistJob({
        ...job,
        status: "failed",
        jobsAhead: undefined,
        message: "服务重启，任务已中断，请重新提交",
        error: "任务执行期间服务发生重启",
        updatedAt: now,
      });
    }
  });
  markInterrupted();
  if (rows.length > 0) {
    console.warn(`[JobStore] 已将 ${rows.length} 个未结束任务标记为重启中断`);
  }
}

export function createJob(request: JobRequest): Job {
  const now = new Date().toISOString();
  const job: Job = {
    jobId: uuidv4(),
    ownerId: request.ownerId ?? "anonymous",
    remoteIp: request.remoteIp,
    status: "pending",
    prompt: request.prompt,
    agentProvider: request.agentProvider,
    pageContext: request.pageContext,
    tapdContext: request.tapdContext,
    submittedBy: request.submittedBy,
    conversationId: request.conversationId,
    conversationHistory: buildConversationHistory(request),
    attachments: request.attachments,
    requiresConfirm: false,
    createdAt: now,
    updatedAt: now,
  };
  persistJob(job);
  return job;
}

export function getJob(jobId: string): Job | undefined {
  const row = getDatabase().prepare("SELECT data FROM jobs WHERE job_id = ?").get(jobId) as
    | JobRow
    | undefined;
  return parseJob(row);
}

export function updateJob(jobId: string, patch: Partial<Job>): Job | undefined {
  const job = getJob(jobId);
  if (!job) return undefined;

  const updated: Job = { ...job, ...patch, updatedAt: new Date().toISOString() };
  persistJob(updated);
  return updated;
}

export function listJobs(ownerId?: string): Job[] {
  const rows = ownerId
    ? (getDatabase()
        .prepare("SELECT data FROM jobs WHERE owner_id = ? ORDER BY created_at DESC")
        .all(ownerId) as JobRow[])
    : (getDatabase().prepare("SELECT data FROM jobs ORDER BY created_at DESC").all() as JobRow[]);
  return rows.map((row) => parseJob(row)!);
}

export function listExpiredJobs(cutoffIso: string): Job[] {
  const rows = getDatabase()
    .prepare(`
      SELECT data
      FROM jobs
      WHERE status IN ('completed', 'failed', 'cancelled', 'awaiting_confirm', 'awaiting_input')
        AND updated_at < ?
      ORDER BY updated_at
    `)
    .all(cutoffIso) as JobRow[];
  return rows.map((row) => parseJob(row)!);
}

export function deleteJobIfExpired(jobId: string, cutoffIso: string): boolean {
  return getDatabase()
    .prepare(`
      DELETE FROM jobs
      WHERE job_id = ?
        AND status IN ('completed', 'failed', 'cancelled', 'awaiting_confirm', 'awaiting_input')
        AND updated_at < ?
    `)
    .run(jobId, cutoffIso).changes > 0;
}

export function deleteJob(jobId: string): boolean {
  return getDatabase().prepare("DELETE FROM jobs WHERE job_id = ?").run(jobId).changes > 0;
}
