import { config } from "../config.js";
import { getDatabase } from "./database.js";
import { gitService } from "./gitService.js";
import { deleteJobIfExpired, listExpiredJobs } from "./jobStore.js";
import { cleanupExpiredOperationLogs } from "./operationLog.js";
import {
  cleanupStagedAttachmentsForAgent,
  deleteJobAttachments,
} from "./uploadService.js";

const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
let cleanupRunning = false;

export async function cleanupExpiredJobs(): Promise<number> {
  const cutoff = new Date(
    Date.now() - config.JOB_RETENTION_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
  const expired = listExpiredJobs(cutoff);
  let deleted = 0;

  for (const job of expired) {
    // 条件删除先于文件清理，避免用户恰好恢复操作时误删仍在使用的附件。
    if (!deleteJobIfExpired(job.jobId, cutoff)) continue;
    deleted += 1;
    if (job.worktreePath) {
      await gitService.removeJobWorktree(job.worktreePath).catch((err) => {
        console.warn(
          `[Housekeeping] 清理任务 ${job.jobId} 工作区失败:`,
          err instanceof Error ? err.message : String(err)
        );
      });
    }
    await cleanupStagedAttachmentsForAgent(gitService.getRepoPath(), job.jobId).catch(() => undefined);
    await deleteJobAttachments(job.jobId).catch((err) => {
      console.warn(
        `[Housekeeping] 清理任务 ${job.jobId} 附件失败:`,
        err instanceof Error ? err.message : String(err)
      );
    });
  }

  if (deleted > 0) {
    getDatabase().pragma("incremental_vacuum(200)");
    console.log(`[Housekeeping] 已清理 ${deleted} 个过期任务`);
  }
  return deleted;
}

export async function runHousekeeping(): Promise<void> {
  if (cleanupRunning) return;
  cleanupRunning = true;
  try {
    await cleanupExpiredOperationLogs();
    await cleanupExpiredJobs();
  } finally {
    cleanupRunning = false;
  }
}

export function initHousekeeping(): void {
  void runHousekeeping().catch((err) => {
    console.warn(
      "[Housekeeping] 启动清理失败:",
      err instanceof Error ? err.message : String(err)
    );
  });

  const timer = setInterval(() => {
    void runHousekeeping().catch((err) => {
      console.warn(
        "[Housekeeping] 定时清理失败:",
        err instanceof Error ? err.message : String(err)
      );
    });
  }, CLEANUP_INTERVAL_MS);
  timer.unref();
}
