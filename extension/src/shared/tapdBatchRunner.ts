import {
  executeJob,
  mergeJob,
  queryJobStatus,
  submitPlan,
} from "./api.js";
import { fetchTapdDescriptionImages } from "./tapdApi.js";
import { compressImageForUpload } from "./imageCompress.js";
import type { JobStatus, JobStatusType, TapdBatchSession, TapdBatchTask } from "./types.js";
import { markTapdTaskCompleted, touchSession } from "./tapdBatchStore.js";

const POLL_MS = 2500;
const JOB_TIMEOUT_MS = 60 * 60 * 1000;

export type BatchPauseReason = {
  phase: string;
  message: string;
  jobId?: string;
};

export type BatchRunnerCallbacks = {
  onSessionUpdate: (session: TapdBatchSession) => void;
  shouldStop: () => boolean;
};

function isTerminal(status: JobStatusType): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function phaseLabel(status: JobStatusType): string {
  const labels: Record<string, string> = {
    planning: "Plan 分析",
    awaiting_confirm: "等待确认 Plan",
    awaiting_input: "需要补充信息",
    awaiting_merge: "等待合并",
    pending: "排队中",
    running: "执行中",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
  };
  return labels[status] ?? status;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForJob(
  serverUrl: string,
  jobId: string,
  startedAt: number,
  shouldStop: () => boolean
): Promise<JobStatus> {
  while (Date.now() - startedAt < JOB_TIMEOUT_MS) {
    if (shouldStop()) {
      throw new Error("批次已暂停");
    }
    const job = await queryJobStatus(serverUrl, jobId);
    if (isTerminal(job.status)) return job;
    if (job.status === "awaiting_confirm" || job.status === "awaiting_merge" || job.status === "awaiting_input") {
      return job;
    }
    await sleep(POLL_MS);
  }
  throw new Error("任务超时（超过 1 小时）");
}

async function prepareJobImages(serverUrl: string, sourceHtml?: string): Promise<Blob[]> {
  if (!sourceHtml?.trim() || !/<img\b/i.test(sourceHtml)) return [];

  const raw = await fetchTapdDescriptionImages(serverUrl, sourceHtml);
  const compressed: Blob[] = [];
  for (const blob of raw) {
    if (compressed.length >= 3) break;
    try {
      compressed.push(await compressImageForUpload(blob));
    } catch {
      // skip failed image
    }
  }
  return compressed;
}

async function driveJobToCompletion(
  serverUrl: string,
  prompt: string,
  sourceHtml: string | undefined,
  shouldStop: () => boolean
): Promise<{ ok: true; jobId: string } | { ok: false; pause: BatchPauseReason; jobId?: string }> {
  const images = await prepareJobImages(serverUrl, sourceHtml);
  const plan = await submitPlan(serverUrl, {
    prompt,
    submittedBy: "tapd-batch",
    images: images.length > 0 ? images : undefined,
  });
  const jobId = plan.jobId;
  const startedAt = Date.now();

  let job = await waitForJob(serverUrl, jobId, startedAt, shouldStop);

  while (!isTerminal(job.status)) {
    if (shouldStop()) {
      return { ok: false, pause: { phase: "用户暂停", message: "批次已手动暂停", jobId }, jobId };
    }

    if (job.status === "awaiting_input") {
      return {
        ok: false,
        pause: {
          phase: phaseLabel(job.status),
          message: job.message || job.planSummary || "Agent 需要补充信息，无法自动继续",
          jobId,
        },
        jobId,
      };
    }

    if (job.status === "awaiting_confirm") {
      const planSummary = job.planSummary?.trim();
      if (!planSummary) {
        return {
          ok: false,
          pause: { phase: phaseLabel(job.status), message: "Plan 方案为空，无法自动执行", jobId },
          jobId,
        };
      }
      await executeJob(serverUrl, jobId, planSummary);
      job = await waitForJob(serverUrl, jobId, startedAt, shouldStop);
      continue;
    }

    if (job.status === "awaiting_merge") {
      try {
        await mergeJob(serverUrl, jobId);
      } catch (err) {
        return {
          ok: false,
          pause: {
            phase: phaseLabel(job.status),
            message: err instanceof Error ? err.message : "自动合并失败",
            jobId,
          },
          jobId,
        };
      }
      job = await waitForJob(serverUrl, jobId, startedAt, shouldStop);
      continue;
    }

    job = await waitForJob(serverUrl, jobId, startedAt, shouldStop);
  }

  if (job.status === "completed") {
    return { ok: true, jobId };
  }

  return {
    ok: false,
    pause: {
      phase: phaseLabel(job.status),
      message: job.error || job.message || `任务 ${job.status}`,
      jobId,
    },
    jobId,
  };
}

function updateTask(
  session: TapdBatchSession,
  taskId: string,
  patch: Partial<TapdBatchTask>
): TapdBatchSession {
  return touchSession({
    ...session,
    tasks: session.tasks.map((task) => (task.id === taskId ? { ...task, ...patch } : task)),
  });
}

export async function runTapdBatch(
  serverUrl: string,
  session: TapdBatchSession,
  callbacks: BatchRunnerCallbacks,
  options?: { startFromTaskId?: string; skipCurrent?: boolean }
): Promise<TapdBatchSession> {
  let current = touchSession({
    ...session,
    status: "running",
    pauseReason: undefined,
    currentTaskId: undefined,
  });
  callbacks.onSessionUpdate(current);

  const startIndex = options?.startFromTaskId
    ? current.tasks.findIndex((task) => task.id === options.startFromTaskId)
    : current.tasks.findIndex((task) => task.status === "pending");

  for (let index = Math.max(0, startIndex); index < current.tasks.length; index += 1) {
    if (callbacks.shouldStop()) {
      current = touchSession({ ...current, status: "paused", pauseReason: "用户暂停" });
      callbacks.onSessionUpdate(current);
      return current;
    }

    let task = current.tasks[index];
    if (!task) continue;
    if (task.status === "completed" || task.status === "skipped") continue;
    if (options?.skipCurrent && task.id === options.startFromTaskId) {
      current = updateTask(current, task.id, { status: "skipped" });
      callbacks.onSessionUpdate(current);
      options = { ...options, skipCurrent: false, startFromTaskId: undefined };
      continue;
    }

    current = touchSession({
      ...updateTask(current, task.id, {
        status: "running",
        error: undefined,
        failedPhase: undefined,
        jobId: undefined,
      }),
      currentTaskId: task.id,
    });
    callbacks.onSessionUpdate(current);
    task = current.tasks[index]!;

    const result = await driveJobToCompletion(
      serverUrl,
      task.prompt,
      task.sourceHtml,
      callbacks.shouldStop
    );

    if (result.ok) {
      await markTapdTaskCompleted(task.tapdTaskId);
      current = updateTask(current, task.id, {
        status: "completed",
        jobId: result.jobId,
        completedAt: new Date().toISOString(),
      });
      callbacks.onSessionUpdate(current);
      continue;
    }

    current = touchSession({
      ...updateTask(current, task.id, {
        status: "failed",
        jobId: result.jobId,
        error: result.pause.message,
        failedPhase: result.pause.phase,
      }),
      status: "paused",
      pauseReason: `${task.title}：${result.pause.phase} — ${result.pause.message}`,
      currentTaskId: task.id,
    });
    callbacks.onSessionUpdate(current);
    return current;
  }

  current = touchSession({
    ...current,
    status: "completed",
    currentTaskId: undefined,
    pauseReason: undefined,
  });
  callbacks.onSessionUpdate(current);
  return current;
}
