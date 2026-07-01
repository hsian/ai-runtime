import { config } from "../config.js";
import { getJob, updateJob } from "./jobStore.js";
import { gitService } from "./gitService.js";
import { appendJobEvent } from "./jobEvents.js";
import type { ReleaseMergeRecord } from "../types.js";

export async function confirmJobMerge(jobId: string): Promise<void> {
  const job = getJob(jobId);
  if (!job) throw new Error("任务不存在");
  if (job.status !== "awaiting_merge" && job.status !== "pending") {
    throw new Error(`当前状态不可合并: ${job.status}`);
  }
  if (!job.branch) {
    throw new Error("缺少待合并分支");
  }

  const defaultBranch = config.GIT_DEFAULT_BRANCH;
  updateJob(jobId, { status: "running", message: `正在合并到 ${defaultBranch}...` });
  appendJobEvent(jobId, {
    type: "stage",
    phase: "merge",
    text: `正在合并到 ${defaultBranch} 并推送...`,
  });

  try {
    const mergeMessage = `merge(plugin): ${job.prompt}\n\nJob: ${jobId}`;
    const mergeSha = await gitService.mergeIntoDefaultBranch(job.branch, mergeMessage);
    const doneMessage = `${job.message ?? "修改已完成"}\n\n已合并到 ${defaultBranch}`;

    updateJob(jobId, {
      status: "completed",
      message: doneMessage,
      sourceBranch: job.sourceBranch ?? job.branch,
      sourceCommitSha: job.sourceCommitSha ?? job.commitSha,
      branch: defaultBranch,
      commitSha: mergeSha,
      mergedToDefaultBranch: defaultBranch,
      mergedToDefaultAt: new Date().toISOString(),
    });
    appendJobEvent(jobId, {
      type: "done",
      text: doneMessage,
      message: doneMessage,
      branch: defaultBranch,
      commitSha: mergeSha,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    updateJob(jobId, { status: "failed", error, message: "合并失败" });
    appendJobEvent(jobId, { type: "error", message: error, text: `合并失败: ${error}` });
    throw err;
  } finally {
    try {
      await gitService.restoreBaseBranch();
    } catch (err) {
      console.warn(
        "[AI Runtime] 合并结束后未能切回基线分支:",
        err instanceof Error ? err.message : String(err)
      );
    }
  }
}

export async function createJobMergeRequest(jobId: string): Promise<void> {
  const job = getJob(jobId);
  if (!job) throw new Error("任务不存在");
  if (job.status !== "awaiting_merge" && job.status !== "pending") {
    throw new Error(`当前状态不可提交 Merge Request: ${job.status}`);
  }
  if (!job.branch) {
    throw new Error("缺少待提交分支");
  }

  const defaultBranch = config.GIT_DEFAULT_BRANCH;
  updateJob(jobId, { status: "running", message: "正在提交 Merge Request..." });
  appendJobEvent(jobId, {
    type: "stage",
    phase: "merge_request",
    text: `正在推送 ${job.branch} 并提交 Merge Request 到 ${defaultBranch}...`,
  });

  try {
    await gitService.pushFeatureBranch(job.branch);
    const title = `fix(plugin): ${job.prompt.slice(0, 80)}`;
    const description = `${job.message ?? "代码修改已完成"}\n\nJob: ${jobId}`;
    const mergeRequest = await gitService.createMergeRequest({
      sourceBranch: job.branch,
      title,
      description,
    });
    const doneMessage = `${job.message ?? "修改已完成"}\n\n已提交 Merge Request: ${mergeRequest.url}`;

    updateJob(jobId, {
      status: "completed",
      message: doneMessage,
      mergeRequestUrl: mergeRequest.url,
    });
    appendJobEvent(jobId, {
      type: "done",
      text: doneMessage,
      message: doneMessage,
      branch: job.branch,
      commitSha: job.commitSha,
      mergeRequestUrl: mergeRequest.url,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    updateJob(jobId, { status: "failed", error, message: "提交 Merge Request 失败" });
    appendJobEvent(jobId, { type: "error", message: error, text: `提交 Merge Request 失败: ${error}` });
    throw err;
  } finally {
    try {
      await gitService.restoreBaseBranch();
    } catch (err) {
      console.warn(
        "[AI Runtime] 提交 Merge Request 后未能切回基线分支:",
        err instanceof Error ? err.message : String(err)
      );
    }
  }
}

export async function mergeCompletedJobToBranch(jobId: string, targetBranch: string): Promise<void> {
  const job = getJob(jobId);
  if (!job) throw new Error("任务不存在");
  if (job.status !== "completed") {
    throw new Error(`当前状态不可合并到其他分支: ${job.status}`);
  }
  if (job.mergedToDefaultBranch !== config.GIT_DEFAULT_BRANCH || job.branch !== config.GIT_DEFAULT_BRANCH) {
    throw new Error(`任务尚未合并到 ${config.GIT_DEFAULT_BRANCH}`);
  }
  const sourceBranch = job.sourceBranch;
  if (!sourceBranch) {
    throw new Error("缺少本次改动分支，无法合并到其他分支");
  }
  const sourceCommitSha = job.sourceCommitSha;
  if (!sourceCommitSha) {
    throw new Error("缺少本次改动提交，无法合并到其他分支");
  }
  if (targetBranch === config.GIT_DEFAULT_BRANCH) {
    throw new Error(`目标分支不能是 ${config.GIT_DEFAULT_BRANCH}`);
  }
  if (targetBranch === sourceBranch) {
    throw new Error("目标分支不能是本次改动分支");
  }

  const existingRecords = job.releaseMerges ?? [];
  if (existingRecords.some((record) => record.targetBranch === targetBranch && record.status === "completed")) {
    throw new Error(`已合并到 ${targetBranch}`);
  }

  updateJob(jobId, { message: `正在合并本次改动到 ${targetBranch}...` });
  appendJobEvent(jobId, {
    type: "stage",
    phase: "release_merge",
    text: `正在将本次提交 ${sourceCommitSha} 应用到 ${targetBranch} 并推送...`,
  });

  try {
    const mergeSha = await gitService.cherryPickCommitIntoBranch(sourceCommitSha, targetBranch);
    const record: ReleaseMergeRecord = {
      targetBranch,
      commitSha: mergeSha,
      status: "completed",
      message: `已合并到 ${targetBranch}`,
      mergedAt: new Date().toISOString(),
    };
    const nextMerges = [
      ...existingRecords.filter((item) => item.targetBranch !== targetBranch),
      record,
    ];

    updateJob(jobId, {
      message: `${job.message ?? "修改已完成"}\n\n已合并到 ${targetBranch}`,
      releaseMerges: nextMerges,
    });
    appendJobEvent(jobId, {
      type: "stage",
      phase: "release_merge_done",
      text: `已合并到 ${targetBranch}`,
      branch: targetBranch,
      commitSha: mergeSha,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const record: ReleaseMergeRecord = {
      targetBranch,
      status: "failed",
      error,
      mergedAt: new Date().toISOString(),
    };
    updateJob(jobId, {
      message: `${job.message ?? "修改已完成"}\n\n合并到 ${targetBranch} 失败: ${error}`,
      releaseMerges: [
        ...existingRecords.filter((item) => item.targetBranch !== targetBranch),
        record,
      ],
    });
    appendJobEvent(jobId, { type: "error", message: error, text: `合并到 ${targetBranch} 失败: ${error}` });
    throw err;
  } finally {
    try {
      await gitService.restoreBaseBranch();
    } catch (err) {
      console.warn(
        "[AI Runtime] 发版分支合并结束后未能切回基线分支:",
        err instanceof Error ? err.message : String(err)
      );
    }
  }
}

export async function discardJobMerge(jobId: string): Promise<void> {
  const job = getJob(jobId);
  if (!job) throw new Error("任务不存在");
  if (job.status !== "awaiting_merge" && job.status !== "pending") {
    throw new Error(`当前状态不可放弃合并: ${job.status}`);
  }

  try {
    if (job.branch) {
      await gitService.discardFeatureBranch(job.branch);
    } else {
      await gitService.restoreBaseBranch();
    }
  } catch (err) {
    console.warn(
      "[AI Runtime] 放弃合并时清理分支失败:",
      err instanceof Error ? err.message : String(err)
    );
    await gitService.restoreBaseBranch();
  }

  updateJob(jobId, { status: "cancelled", message: "已放弃合并，test 分支未改动" });
  appendJobEvent(jobId, {
    type: "cancelled",
    message: "已放弃合并",
    text: "已放弃合并：已切回 test 分支，test 未做任何改动",
  });
}
