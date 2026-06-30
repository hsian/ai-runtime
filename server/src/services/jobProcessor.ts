import { config } from "../config.js";
import { getJob, updateJob } from "./jobStore.js";
import { gitService } from "./gitService.js";
import { runAgent } from "./agent/index.js";
import { looksLikeClarification } from "./agent/types.js";
import { buildCommitMessage, formatGitError } from "./commitMessage.js";
import { appendJobEvent } from "./jobEvents.js";
import { stageAttachmentsForAgent } from "./uploadService.js";
import { resolveJobPreviewLink } from "./devPreviewService.js";
import type { AgentStreamEvent } from "./agent/types.js";

function isNoChangesError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("没有文件变更");
}

function emitStage(jobId: string, phase: string, text: string): void {
  appendJobEvent(jobId, { type: "stage", phase, text });
  updateJob(jobId, { message: text });
}

function emitAgentEvent(jobId: string, event: AgentStreamEvent): void {
  if (event.type === "agent_text" && event.delta) {
    appendJobEvent(jobId, { type: "agent_text", delta: event.delta });
    return;
  }

  if (event.type === "agent_status" && event.statusText) {
    appendJobEvent(jobId, {
      type: "agent_status",
      statusText: event.statusText,
      text: event.statusText,
    });
    updateJob(jobId, { message: event.statusText });
    return;
  }

  if (event.type === "agent_tool" && event.toolName) {
    appendJobEvent(jobId, {
      type: "agent_tool",
      toolAction: event.toolAction ?? "start",
      toolName: event.toolName,
      toolDetail: event.toolDetail,
      text: event.toolAction === "done"
        ? `✓ ${event.toolName}`
        : `▶ ${event.toolName}${event.toolDetail ? `: ${event.toolDetail}` : ""}`,
    });
  }
}

function isCancelled(jobId: string): boolean {
  return getJob(jobId)?.status === "cancelled";
}

async function abortIfCancelled(jobId: string, phase: string): Promise<boolean> {
  if (!isCancelled(jobId)) return false;
  appendJobEvent(jobId, { type: "stage", phase: "abort", text: `任务已取消，停止在阶段: ${phase}` });
  await gitService.discardUncommittedChanges();
  return true;
}

function finishJob(
  jobId: string,
  patch: {
    status: "completed" | "failed";
    message: string;
    error?: string;
    branch?: string;
    commitSha?: string;
  }
): void {
  updateJob(jobId, patch);
  if (patch.status === "failed") {
    appendJobEvent(jobId, {
      type: "error",
      message: patch.error ?? patch.message,
      text: patch.error ?? patch.message,
    });
    return;
  }

  appendJobEvent(jobId, {
    type: "done",
    text: patch.message,
    message: patch.message,
    branch: patch.branch,
    commitSha: patch.commitSha,
  });
}

export async function processJob(jobId: string): Promise<void> {
  if (isCancelled(jobId)) return;

  const job = updateJob(jobId, {
    status: "running",
    message: "正在拉取代码...",
    jobsAhead: 0,
  });
  if (!job) return;

  if (job.requiresConfirm && job.status !== "running") {
    // defensive: should not happen because queue only enqueues pending jobs
    return;
  }

  const branchName = `plugin-fix/${jobId.slice(0, 8)}`;
  const defaultBranch = config.GIT_DEFAULT_BRANCH;

  try {
    emitStage(jobId, "pull", `正在拉取 ${defaultBranch} 分支最新代码...`);
    await gitService.prepareBaseBranch();
    if (await abortIfCancelled(jobId, "pull")) return;

    emitStage(jobId, "branch", `正在创建分支 ${branchName}...`);
    await gitService.createBranch(branchName);
    if (await abortIfCancelled(jobId, "branch")) return;

    emitStage(jobId, "agent", "Claude Code 正在分析并修改代码...");

    const repoPath = gitService.getRepoPath();
    const stagedAttachments = await stageAttachmentsForAgent(job.attachments, repoPath, jobId);
    if (stagedAttachments?.length) {
      emitStage(jobId, "attachments", `已准备 ${stagedAttachments.length} 张截图供分析`);
    }

    const result = await runAgent(
      repoPath,
      job.prompt,
      job.pageContext,
      (event) => emitAgentEvent(jobId, event),
      {
        mode: "execute",
        jobId,
        attachments: stagedAttachments,
        confirmedPlan: job.requiresConfirm ? job.planSummary : undefined,
      }
    );
    if (await abortIfCancelled(jobId, "agent")) return;

    const hasChanges = await gitService.hasUncommittedChanges();

    if (!hasChanges) {
      if (looksLikeClarification(result.summary)) {
        finishJob(jobId, {
          status: "failed",
          error: "Claude Code 未执行修改，而是在等待澄清",
          message: result.summary,
          branch: branchName,
        });
        return;
      }

      finishJob(jobId, {
        status: "completed",
        message: result.summary || "未产生代码变更",
        branch: branchName,
      });
      return;
    }

    emitStage(
      jobId,
      "commit",
      config.PUSH_FEATURE_BRANCH
        ? "正在提交并推送代码..."
        : "正在提交代码（feature 分支不推送，仅合并后推送 test）..."
    );
    if (await abortIfCancelled(jobId, "commit")) return;
    const commitMessage = buildCommitMessage(job.prompt, result.summary, jobId);
    const commitSha = await gitService.commitAndPush(branchName, commitMessage);

    if (job.requiresConfirm) {
      const defaultBranch = config.GIT_DEFAULT_BRANCH;
      const pendingMessage = result.summary || "代码修改已完成";
      let previewUrl: string | undefined;
      let previewFilter: string | undefined;
      let previewNotice = "预览未启动";

      try {
        const changedFiles = await gitService.listChangedFilesAgainstDefault(branchName);
        const preview = await resolveJobPreviewLink({
          repoPath,
          changedFiles,
          previewHost: job.previewHost,
        });
        previewUrl = preview?.url;
        previewFilter = preview?.filter;
        previewNotice = preview
          ? `预览地址：${preview.url}`
          : "未能从本次改动推断可预览的 app 或端口";
      } catch (err) {
        previewNotice = `预览地址生成失败：${err instanceof Error ? err.message : String(err)}`;
      }

      updateJob(jobId, {
        status: "awaiting_merge",
        branch: branchName,
        commitSha,
        message: pendingMessage,
        previewUrl,
        previewFilter,
        previewMessage: previewNotice,
      });
      appendJobEvent(jobId, {
        type: "stage",
        phase: "execute_ready",
        text: `代码修改已提交到 ${branchName}，请确认是否合并到 ${defaultBranch}`,
        previewUrl,
        previewMessage: previewNotice,
      });
      return;
    }

    let finalBranch = branchName;
    let mergeSha = commitSha;

    if (config.AUTO_MERGE_TO_DEFAULT_BRANCH) {
      emitStage(jobId, "merge", `正在合并到 ${defaultBranch} 并推送...`);
      if (await abortIfCancelled(jobId, "merge")) return;
      const mergeMessage = `merge(plugin): ${job.prompt}\n\nJob: ${jobId}`;
      mergeSha = await gitService.mergeIntoDefaultBranch(branchName, mergeMessage);
      finalBranch = defaultBranch;
    }

    const doneMessage = config.AUTO_MERGE_TO_DEFAULT_BRANCH
      ? `${result.summary}\n\n已合并到 ${defaultBranch}`
      : result.summary;

    finishJob(jobId, {
      status: "completed",
      message: doneMessage,
      branch: finalBranch,
      commitSha: mergeSha,
    });
  } catch (err) {
    if (isNoChangesError(err)) {
      finishJob(jobId, {
        status: "failed",
        error: "未产生代码变更",
        message: "Claude Code 执行完成但没有修改任何文件",
        branch: branchName,
      });
      return;
    }

    const error = formatGitError(err);
    finishJob(jobId, {
      status: "failed",
      error,
      message: "任务执行失败",
      branch: branchName,
    });
  } finally {
    try {
      const latest = getJob(jobId);
      if (latest?.status !== "awaiting_merge" || !latest.previewUrl) {
        await gitService.restoreBaseBranch();
      }
    } catch (err) {
      console.warn(
        "[AI Runtime] 任务结束后未能切回基线分支:",
        err instanceof Error ? err.message : String(err)
      );
    }
  }
}
