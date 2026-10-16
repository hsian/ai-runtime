import { getJob, updateJob } from "./jobStore.js";
import { appendJobEvent } from "./jobEvents.js";
import { jobQueue } from "./jobQueue.js";
import { confirmJobMerge, createJobMergeRequest, discardJobMerge, mergeCompletedJobToBranch } from "./jobMergeService.js";
import { getProjectGitService } from "./projectRuntime.js";
import { getTaskState } from "@ai-runtime/shared/task-state";

type Worker = (jobId: string) => Promise<void>;

/** Entry points authorize identity; this service owns operation rules and queueing. */
export function requestTaskMerge(jobId: string, options: {
  createMergeRequest?: boolean; discard?: boolean;
  enqueue?: (id: string, worker: Worker) => number;
} = {}): number {
  const job = getJob(jobId);
  if (!job) throw new Error("任务不存在");
  if (job.status !== "awaiting_merge") throw new Error(`当前状态不可合并: ${job.status}`);
  if (job.workbenchTurnRunning) throw new Error("本轮尚未结束，请稍后操作合并");
  if (!options.discard && job.workbenchSession && !getTaskState(job).canComplete) throw new Error("还没有实际代码修改，或本轮尚未结束，不能完成或合并任务");
  const createMergeRequest = !job.mergeRetryable && options.createMergeRequest === true;
  updateJob(jobId, { status: "pending", message: options.discard ? "已确认放弃合并，等待排队…" : createMergeRequest ? "已确认提交 Merge Request，等待排队…" : "已确认合并，等待排队…", mergeRetryable: false });
  const worker: Worker = async id => {
    try {
      if (options.discard) await discardJobMerge(id);
      else if (createMergeRequest) await createJobMergeRequest(id);
      else await confirmJobMerge(id);
    } catch (cause) {
      const latest = getJob(id);
      const error = cause instanceof Error ? cause.message : String(cause);
      if (latest && !["completed", "awaiting_merge"].includes(latest.status)) updateJob(id, { status: "failed", error, message: "合并处理失败，代码已保留" });
      appendJobEvent(id, { type: "error", text: error, message: error });
      throw cause;
    }
  };
  return options.enqueue ? options.enqueue(jobId, worker) : jobQueue.enqueueGateContinuation(jobId, worker) ?? jobQueue.enqueue(jobId, worker);
}

export async function releaseTaskToBranch(jobId: string, targetBranch: string, options: { fromConversation?: boolean } = {}): Promise<void> {
  const job = getJob(jobId);
  if (!job) throw new Error("任务不存在");
  const target = targetBranch.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/.test(target)) throw new Error("目标分支名无效");
  if (job.status !== "completed" || !job.mergedToDefaultAt || !job.sourceCommitSha || job.revertedFromDefaultAt) throw new Error("请先完成代码修改和默认分支合并，再合并发版分支");
  if (job.workbenchTurnRunning && !options.fromConversation) throw new Error("当前任务仍在处理，请稍后重试");
  if (target === job.mergedToDefaultBranch || job.releaseMerges?.some(record => record.targetBranch === target && record.status === "completed")) return;
  if (!(await getProjectGitService(job.projectId).listRemoteBranches()).includes(target)) throw new Error(`远程分支 ${target} 不存在，请核对完整分支名`);
  const { done } = jobQueue.enqueueAndWait(jobId, async id => {
    // Recheck inside the queue: another entry point may have completed this release.
    if (getJob(id)?.releaseMerges?.some(record => record.targetBranch === target && record.status === "completed")) return;
    await mergeCompletedJobToBranch(id, target);
  });
  await done;
}
