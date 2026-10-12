import type { Job } from "../../types.js";
import { config } from "../../config.js";
import { normalizePreviewHost } from "../devPreviewService.js";
import { createResourceDownloadToken, verifyResourceDownloadToken } from "../clientIdentity.js";

function downloadResource(job: Job): string {
  return `test-case:${job.jobId}:${job.ownerId ?? ""}`;
}

export function testCaseDownloadUrl(job: Job, now = Date.now()): string | undefined {
  if (job.taskMode !== "test-case" || job.status !== "completed" || !job.testCaseDocument) return undefined;
  const host = normalizePreviewHost(job.previewHost ?? process.env.QWECHAT_BOT_PREVIEW_HOST);
  const url = new URL(`http://${host}:${config.PORT}/api/test-case-downloads/${encodeURIComponent(job.jobId)}`);
  url.searchParams.set("token", createResourceDownloadToken(downloadResource(job), now + 24 * 60 * 60 * 1000));
  return url.toString();
}

export function authorizeTestCaseDownload(job: Job, token: unknown, now = Date.now()): boolean {
  return job.taskMode === "test-case" && job.status === "completed" && Boolean(job.testCaseDocument)
    && verifyResourceDownloadToken(downloadResource(job), token, now);
}
