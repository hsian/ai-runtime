import type { Job } from "../types.js";
import { config } from "../config.js";
import { getTaskState } from "@ai-runtime/shared/task-state";

export function toPublicJob(job: Job) {
  const { attachments, conversationHistory: _history, ownerId: _owner, remoteIp: _ip, previewHost: _host,
    worktreePath: _path, workbenchArchivedWorktrees: _archived, ...publicJob } = job;
  return { ...publicJob, taskState: getTaskState(job), agentProvider: job.agentProvider ?? config.AGENT_PROVIDER,
    attachments: attachments?.map((attachment, index) => ({ index, name: attachment.name, mime: attachment.mime,
      sizeBytes: attachment.sizeBytes, url: `/api/jobs/${encodeURIComponent(job.jobId)}/attachments/${index}` })) };
}

export function toJobSummary(job: Job) {
  const { workbenchMessages, conversationHistory: _history, attachments: _attachments, pageContext: _page,
    planSummary: _plan, testCaseDocument: _document, workbenchLatestPrompt: _prompt, workbenchQuestion: _question, ...metadata } = job;
  return { ...toPublicJob(metadata), taskState: getTaskState(job), prompt: job.prompt.slice(0, 300),
    message: job.message?.slice(0, 600), implementationSummary: job.implementationSummary?.slice(0, 600),
    conversationTitle: workbenchMessages?.find(message => message.role === "user")?.text.slice(0, 60) || job.prompt.slice(0, 60),
    tapdContext: job.tapdContext ? { workspaceId: job.tapdContext.workspaceId, itemType: job.tapdContext.itemType,
      itemId: job.tapdContext.itemId, title: job.tapdContext.title, url: job.tapdContext.url, description: "",
      fetchedAt: job.tapdContext.fetchedAt, status: job.tapdContext.status } : undefined };
}
