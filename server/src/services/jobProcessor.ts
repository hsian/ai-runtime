import { config } from "../config.js";
import { getJob, updateJob } from "./jobStore.js";
import { GitMergeConflictError, GitRemoteUnavailableError, gitService } from "./gitService.js";
import { runAgent } from "./agent/index.js";
import { looksLikeClarification } from "./agent/types.js";
import { buildCommitMessage, buildMergeMessage, formatGitError } from "./commitMessage.js";
import { appendJobEvent } from "./jobEvents.js";
import { stageAttachmentsForAgent } from "./uploadService.js";
import { resolveJobPreviewLink } from "./devPreviewService.js";
import type { AgentStreamEvent } from "./agent/types.js";
import { createJobConflictResolver } from "./gitConflictResolutionService.js";
import { buildPromptWithTapdContext } from "./tapd/tapdContext.js";
import { logOperation } from "./operationLog.js";

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

function buildCodexRetryPrompt(prompt: string): string {
  return [
    prompt,
    "",
    "【系统补充】",
    "上一次 Codex CLI 返回了说明性文本，但工作区没有任何文件变更。",
    "请继续执行同一个任务，必须实际修改源码文件。",
    "不要只描述计划，不要说“我会”；完成前请确认 Git 工作区已经产生变更。",
  ].join("\n");
}

async function abortIfCancelled(jobId: string, phase: string, repoPath?: string): Promise<boolean> {
  if (!isCancelled(jobId)) return false;
  appendJobEvent(jobId, { type: "stage", phase: "abort", text: `任务已取消，停止在阶段: ${phase}` });
  await gitService.discardUncommittedChanges(repoPath);
  return true;
}

function finishJob(
  jobId: string,
  patch: {
    status: "completed" | "failed";
    message: string;
    error?: string;
    sourceBranch?: string;
    sourceCommitSha?: string;
    branch?: string;
    commitSha?: string;
    mergedToDefaultBranch?: string;
    mergedToDefaultAt?: string;
    previewUrl?: string;
    previewFilter?: string;
    previewMessage?: string;
    mergeRetryable?: boolean;
    implementationSummary?: string;
    phase?: string;
  }
): void {
  const existing = getJob(jobId);
  const engine = existing?.agentProvider ?? config.AGENT_PROVIDER;
  updateJob(jobId, patch);
  logOperation({
    action: "job_execute",
    status: patch.status === "completed" ? "success" : "failed",
    jobId,
    ownerId: existing?.ownerId,
    mode: "execute",
    engine,
    durationMs: existing ? Date.now() - new Date(existing.createdAt).getTime() : undefined,
    branch: patch.branch,
    commitSha: patch.commitSha,
    error: patch.error,
  });
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
    previewUrl: patch.previewUrl,
    previewMessage: patch.previewMessage,
    mergeRetryable: patch.mergeRetryable,
    phase: patch.phase,
  });
}

export async function processJob(jobId: string): Promise<void> {
  if (isCancelled(jobId)) return;

  const job = updateJob(jobId, {
    status: "running",
    message: "正在准备独立工作区...",
    jobsAhead: 0,
  });
  if (!job) return;
  const agentStartedAt = Date.now();
  const engine = job.agentProvider ?? config.AGENT_PROVIDER;
  logOperation({
    action: "job_execute",
    status: "started",
    jobId,
    ownerId: job.ownerId,
    mode: "execute",
    engine,
    attachmentCount: job.attachments?.length,
  });

  if (!job.requiresConfirm || !job.planSummary?.trim()) {
    finishJob(jobId, {
      status: "failed",
      error: "禁止绕过 Plan 直接修改代码",
      message: "代码修改必须先完成并确认 Plan",
    });
    return;
  }

  const branchName = `plugin-fix/${jobId.slice(0, 8)}`;
  const defaultBranch = config.GIT_DEFAULT_BRANCH;
  let repoPath: string | undefined;
  let taskCommitSha: string | undefined;
  let implementationSummary: string | undefined;
  let misplacedChangePaths: string[] = [];

  try {
    const initialWorkspaceDirtyPaths = await gitService.listUncommittedPaths();
    if (initialWorkspaceDirtyPaths.length > 0) {
      finishJob(jobId, {
        status: "failed",
        error: `业务主仓库存在未提交改动，请先处理后再执行: ${initialWorkspaceDirtyPaths.join(", ")}`,
        message: "业务主仓库存在未提交改动，已停止执行",
        sourceBranch: branchName,
        branch: branchName,
      });
      return;
    }

    emitStage(jobId, "pull", `正在基于 ${defaultBranch} 创建独立工作区...`);
    repoPath = await gitService.createJobWorktree(jobId, branchName);
    updateJob(jobId, { worktreePath: repoPath });
    if (await abortIfCancelled(jobId, "pull", repoPath)) return;

    emitStage(jobId, "branch", `已创建独立工作区和分支 ${branchName}`);
    if (await abortIfCancelled(jobId, "branch", repoPath)) return;

    const stagedAttachments = await stageAttachmentsForAgent(job.attachments, repoPath, jobId);
    if (stagedAttachments?.length) {
      emitStage(jobId, "attachments", `已准备 ${stagedAttachments.length} 张截图供分析`);
    }

    emitStage(jobId, "agent", "正在分析并修改代码...");

    const result = await runAgent(
      repoPath,
      buildPromptWithTapdContext(job.prompt, job.tapdContext),
      job.pageContext,
      (event) => emitAgentEvent(jobId, event),
      {
        mode: "execute",
        jobId,
        agentProvider: engine,
        attachments: stagedAttachments,
        confirmedPlan: job.requiresConfirm ? job.planSummary : undefined,
        conversationHistory: job.conversationHistory,
      }
    );
    implementationSummary = result.summary;
    logOperation({
      action: "agent_execute",
      status: "success",
      jobId,
      ownerId: job.ownerId,
      mode: "execute",
      engine,
      durationMs: Date.now() - agentStartedAt,
    });
    if (await abortIfCancelled(jobId, "agent", repoPath)) return;

    let hasChanges = await gitService.hasUncommittedChanges(repoPath);

    if (!hasChanges && engine === "codex") {
      emitStage(jobId, "agent_retry", "Codex 未产生代码变更，正在自动重试执行...");
      const retryResult = await runAgent(
        repoPath,
        buildPromptWithTapdContext(buildCodexRetryPrompt(job.prompt), job.tapdContext),
        job.pageContext,
        (event) => emitAgentEvent(jobId, event),
        {
          mode: "execute",
          jobId,
          agentProvider: engine,
          attachments: stagedAttachments,
          confirmedPlan: job.requiresConfirm ? job.planSummary : undefined,
          conversationHistory: job.conversationHistory,
        }
      );
      implementationSummary = retryResult.summary || implementationSummary;
      hasChanges = await gitService.hasUncommittedChanges(repoPath);
      if (hasChanges) {
        result.summary = retryResult.summary || result.summary;
      }
    }

    if (!hasChanges) {
      const workspaceDirtyPaths = await gitService.listUncommittedPaths();
      if (workspaceDirtyPaths.length > 0) {
        emitStage(jobId, "commit", "检测到改动落在业务主仓库，正在转移到任务工作区...");
        misplacedChangePaths = await gitService.copyUncommittedChanges(
          gitService.getRepoPath(),
          repoPath
        );
        hasChanges = await gitService.hasUncommittedChanges(repoPath);
      }
    }

    if (!hasChanges) {
      if (looksLikeClarification(result.summary)) {
        finishJob(jobId, {
          status: "failed",
          error: "未执行修改，而是在等待澄清",
          message: result.summary,
          sourceBranch: branchName,
          branch: branchName,
        });
        return;
      }

      finishJob(jobId, {
        status: "failed",
        error: "执行完成但隔离工作区没有产生代码变更，未创建 commit",
        message: result.summary || "未产生代码变更",
        sourceBranch: branchName,
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
    if (await abortIfCancelled(jobId, "commit", repoPath)) return;
    const commitMessage = buildCommitMessage(result.summary, jobId);
    const commitSha = await gitService.commitAndPush(branchName, commitMessage, repoPath);
    taskCommitSha = commitSha;
    logOperation({
      action: "git_commit",
      status: "success",
      jobId,
      ownerId: job.ownerId,
      branch: branchName,
      commitSha,
      message: config.PUSH_FEATURE_BRANCH ? "committed_and_pushed" : "committed_locally",
    });
    if (misplacedChangePaths.length > 0) {
      await gitService.discardSpecificUncommittedChanges(misplacedChangePaths);
    }

    let previewUrl: string | undefined;
    let previewFilter: string | undefined;
    let previewNotice = "未能从本次改动推断可预览的 app 或端口";

    try {
      const changedFiles = await gitService.listChangedFilesAgainstDefault(branchName, repoPath);
      const preview = await resolveJobPreviewLink({
        repoPath,
        changedFiles,
        previewHost: job.previewHost,
      });
      previewUrl = preview?.url;
      previewFilter = preview?.filter;
      if (preview) previewNotice = `预览地址：${preview.url}`;
    } catch (err) {
      previewNotice = `预览地址生成失败：${err instanceof Error ? err.message : String(err)}`;
    }

    let finalBranch = branchName;
    let mergeSha = commitSha;

    emitStage(jobId, "merge", `正在合并到 ${defaultBranch} 并推送...`);
    if (await abortIfCancelled(jobId, "merge", repoPath)) return;
    const mergeMessage = buildMergeMessage(result.summary, jobId);
    mergeSha = await gitService.mergeIntoDefaultBranch(
      branchName,
      mergeMessage,
      createJobConflictResolver(jobId)
    );
    logOperation({
      action: "git_merge",
      status: "success",
      jobId,
      ownerId: job.ownerId,
      branch: branchName,
      targetBranch: defaultBranch,
      commitSha: mergeSha,
      message: "merged_and_pushed",
    });
    finalBranch = defaultBranch;

    const doneMessage = `${result.summary}\n\n已合并到 ${defaultBranch}`;

    finishJob(jobId, {
      status: "completed",
      message: doneMessage,
      sourceBranch: branchName,
      sourceCommitSha: commitSha,
      branch: finalBranch,
      commitSha: mergeSha,
      mergedToDefaultBranch: defaultBranch,
      mergedToDefaultAt: new Date().toISOString(),
      previewUrl,
      previewFilter,
      previewMessage: previewNotice,
      mergeRetryable: false,
      implementationSummary: result.summary,
      phase: "default_merge_done",
    });
  } catch (err) {
    if (err instanceof GitRemoteUnavailableError && repoPath && taskCommitSha) {
      const retryMessage = `${err.message}。代码修改和任务分支已保留，请在仓库恢复后重试合并到 ${config.GIT_DEFAULT_BRANCH}`;
      updateJob(jobId, {
        status: "awaiting_merge",
        error: err.message,
        message: retryMessage,
        sourceBranch: branchName,
        sourceCommitSha: taskCommitSha,
        worktreePath: repoPath,
        branch: branchName,
        commitSha: taskCommitSha,
        previewUrl: undefined,
        previewMessage: `远程 ${config.GIT_DEFAULT_BRANCH} 尚未更新，当前预览仍是旧代码`,
        mergeRetryable: true,
        implementationSummary,
      });
      appendJobEvent(jobId, {
        type: "stage",
        phase: "merge_retryable",
        text: retryMessage,
        previewMessage: `远程 ${config.GIT_DEFAULT_BRANCH} 尚未更新，当前预览仍是旧代码`,
        mergeRetryable: true,
      });
      return;
    }

    if (err instanceof GitMergeConflictError && repoPath) {
      const fallbackMessage = `自动合并到 ${config.GIT_DEFAULT_BRANCH} 失败，已保留任务分支，请转 Merge Request 或人工处理。${err.message}`;
      updateJob(jobId, {
        status: "awaiting_merge",
        error: err.message,
        message: fallbackMessage,
        sourceBranch: branchName,
        sourceCommitSha: taskCommitSha,
        worktreePath: repoPath,
        branch: branchName,
        commitSha: taskCommitSha,
        previewUrl: undefined,
        previewMessage: "自动合并尚未完成，当前预览仍是 test 旧代码",
        mergeRetryable: false,
        implementationSummary,
      });
      appendJobEvent(jobId, {
        type: "stage",
        phase: "execute_ready",
        text: fallbackMessage,
        previewMessage: "自动合并尚未完成，当前预览仍是 test 旧代码",
        mergeRetryable: false,
      });
      return;
    }

    if (isNoChangesError(err)) {
      finishJob(jobId, {
        status: "failed",
        error: "未产生代码变更",
        message: "执行完成但没有修改任何文件",
        sourceBranch: branchName,
        branch: branchName,
      });
      return;
    }

    const error = formatGitError(err);
    finishJob(jobId, {
      status: "failed",
      error,
      message: "任务执行失败",
      sourceBranch: branchName,
      branch: branchName,
    });
  } finally {
    try {
      const latest = getJob(jobId);
      if (repoPath && latest?.status !== "awaiting_merge") {
        await gitService.removeJobWorktree(repoPath, branchName);
        updateJob(jobId, { worktreePath: undefined });
      }
    } catch (err) {
      console.warn(
        "[AI Runtime] 任务结束后未能清理 worktree:",
        err instanceof Error ? err.message : String(err)
      );
    }
  }
}
