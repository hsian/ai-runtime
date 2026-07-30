import { v4 as uuidv4 } from "uuid";
import type { ConversationHistoryMessage, Job, JobRequest } from "../types.js";

const jobs = new Map<string, Job>();
const MAX_HISTORY_JOBS = 10;
const MAX_HISTORY_CHARS = 16_000;

export interface ConversationContextStats {
  usedJobs: number;
  maxJobs: number;
  usedChars: number;
  maxChars: number;
}

function buildConversationHistory(request: JobRequest): ConversationHistoryMessage[] | undefined {
  if (!request.conversationId) return undefined;

  const related = Array.from(jobs.values())
    .filter(
      (job) =>
        job.ownerId === (request.ownerId ?? "anonymous") &&
        job.conversationId === request.conversationId &&
        ["completed", "awaiting_confirm", "awaiting_input", "awaiting_merge"].includes(
          job.status
        )
    )
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    .slice(-MAX_HISTORY_JOBS);

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
  const history =
    buildConversationHistory({ prompt: "", ownerId, conversationId }) ?? [];
  return {
    usedJobs: history.filter((message) => message.role === "user").length,
    maxJobs: MAX_HISTORY_JOBS,
    usedChars: history.reduce((sum, message) => sum + message.content.length, 0),
    maxChars: MAX_HISTORY_CHARS,
  };
}

export function getJobsMap(): Map<string, Job> {
  return jobs;
}

export function initJobStore(): void {
  // 任务仅保存在内存中，服务重启后清空
}

export function createJob(request: JobRequest): Job {
  const now = new Date().toISOString();
  const job: Job = {
    jobId: uuidv4(),
    ownerId: request.ownerId ?? "anonymous",
    status: "pending",
    prompt: request.prompt,
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
  jobs.set(job.jobId, job);
  return job;
}

export function getJob(jobId: string): Job | undefined {
  return jobs.get(jobId);
}

export function updateJob(jobId: string, patch: Partial<Job>): Job | undefined {
  const job = jobs.get(jobId);
  if (!job) return undefined;

  const updated: Job = { ...job, ...patch, updatedAt: new Date().toISOString() };
  jobs.set(jobId, updated);
  return updated;
}

export function listJobs(ownerId?: string): Job[] {
  const all = Array.from(jobs.values());
  const visible = ownerId
    ? all.filter((job) => job.ownerId === ownerId || !job.ownerId)
    : all;
  return visible.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}
