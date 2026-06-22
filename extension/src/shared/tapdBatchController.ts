import {
  cancelJob,
  discardMerge,
  executeJob,
  fetchJobEvents,
  mergeJob,
  openJobEventStream,
  queryJobStatus,
  replyToPlan,
  submitPlan,
} from "./api.js";
import type { JobEvent, JobStatus, JobStatusType, TapdBatchSession, TapdBatchTask } from "./types.js";
import {
  appendTapdImageInstructions,
  prepareTapdJobImages,
} from "./tapdJobImages.js";
import {
  markTapdTaskCompleted,
  saveTapdBatchSession,
  touchSession,
  loadTapdBatchSession,
} from "./tapdBatchStore.js";
import { TAPD_BATCH_JOB_EVENT, TAPD_BATCH_JOB_LOG, TAPD_BATCH_STATE } from "./tapdBatchMessages.js";

const POLL_MS = 2000;
const JOB_TIMEOUT_MS = 60 * 60 * 1000;
const SERVER_URL_KEY = "tapdBatchServerUrl";

const RESUMABLE_SESSION_STATUSES = new Set<TapdBatchSession["status"]>([
  "running",
  "waiting_confirm",
  "waiting_merge",
  "waiting_input",
  "paused",
]);

function shouldAutoResumeSession(next: TapdBatchSession | null): boolean {
  if (!next) return false;
  return (
    next.status === "running" ||
    next.status === "waiting_confirm" ||
    next.status === "waiting_merge" ||
    next.status === "waiting_input"
  );
}

type UserGate = "execute" | "merge" | "cancel" | "reply";

let serverUrl = "";
let session: TapdBatchSession | null = null;
let stopRequested = false;
let batchCancelled = false;
let loopRunning = false;
let activeEventSource: EventSource | null = null;
let userGateResolve: ((gate: UserGate) => void) | null = null;
let userGateExpected: "execute" | "merge" | "reply" | null = null;
let pendingPlanSummary = "";
let pendingPlanReply = "";

function isTerminal(status: JobStatusType): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

async function persistServerUrl(url: string): Promise<void> {
  serverUrl = url.replace(/\/$/, "");
  await chrome.storage.local.set({ [SERVER_URL_KEY]: serverUrl });
}

async function loadPersistedServerUrl(): Promise<string> {
  if (serverUrl) return serverUrl;
  const stored = await chrome.storage.local.get([SERVER_URL_KEY]);
  const value = stored[SERVER_URL_KEY];
  if (typeof value === "string" && value.trim()) {
    serverUrl = value.replace(/\/$/, "");
  }
  return serverUrl;
}

function isResumableSession(next: TapdBatchSession | null): boolean {
  return Boolean(next && RESUMABLE_SESSION_STATUSES.has(next.status));
}

async function ensureSessionLoaded(): Promise<TapdBatchSession | null> {
  if (session) return session;
  session = await loadTapdBatchSession();
  return session;
}

async function resumeBatchLoopIfNeeded(triggerServerUrl?: string): Promise<void> {
  if (loopRunning) return;
  const current = await ensureSessionLoaded();
  if (!shouldAutoResumeSession(current)) return;
  if (triggerServerUrl) await persistServerUrl(triggerServerUrl);
  if (!(await loadPersistedServerUrl())) return;
  void runBatchLoop(current!, { resume: true });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function emitSession(next: TapdBatchSession | null): Promise<void> {
  session = next;
  await saveTapdBatchSession(next);
  chrome.runtime.sendMessage({ type: TAPD_BATCH_STATE, session: next }).catch(() => {});
}

async function clearJobLog(jobId: string): Promise<void> {
  await chrome.storage.local.set({ [TAPD_BATCH_JOB_LOG]: { jobId, events: [] as JobEvent[] } });
}

async function appendJobLog(event: JobEvent): Promise<void> {
  const stored = await chrome.storage.local.get([TAPD_BATCH_JOB_LOG]);
  const current = stored[TAPD_BATCH_JOB_LOG] as { jobId: string; events: JobEvent[] } | undefined;
  const events = current?.jobId === event.jobId ? [...current.events, event] : [event];
  await chrome.storage.local.set({ [TAPD_BATCH_JOB_LOG]: { jobId: event.jobId, events } });
  chrome.runtime.sendMessage({ type: TAPD_BATCH_JOB_EVENT, event }).catch(() => {});
}

function closeEventStream(): void {
  activeEventSource?.close();
  activeEventSource = null;
}

function attachJobStream(jobId: string): void {
  closeEventStream();
  if (!serverUrl) return;
  const seen = new Set<string>();
  activeEventSource = openJobEventStream(serverUrl, jobId, (event) => {
    if (seen.has(event.id)) return;
    seen.add(event.id);
    void appendJobLog(event);
  });
}

async function waitForJobStatus(
  jobId: string,
  stopStatuses: JobStatusType[],
  startedAt: number
): Promise<JobStatus> {
  while (Date.now() - startedAt < JOB_TIMEOUT_MS) {
    if (stopRequested) throw new Error("用户暂停");
    const job = await queryJobStatus(serverUrl, jobId);
    if (stopStatuses.includes(job.status) || isTerminal(job.status)) return job;
    await sleep(POLL_MS);
  }
  throw new Error("任务超时（超过 1 小时）");
}

async function cancelActiveJobOnServer(jobId: string): Promise<void> {
  await loadPersistedServerUrl();
  if (!serverUrl) return;

  try {
    const job = await queryJobStatus(serverUrl, jobId);
    if (job.status === "awaiting_merge") {
      await discardMerge(serverUrl, jobId);
      return;
    }
    if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
      return;
    }
    await cancelJob(serverUrl, jobId);
  } catch {
    // best-effort cleanup
  }
}

async function cancelBatchSession(): Promise<void> {
  batchCancelled = true;
  stopRequested = true;
  userGateResolve?.("cancel");
  closeEventStream();

  const activeJobId = session?.activeJobId;
  if (activeJobId) {
    await cancelActiveJobOnServer(activeJobId);
  }

  if (!session) return;

  const currentTaskId = session.currentTaskId;
  const next = touchSession({
    ...session,
    status: "cancelled",
    pauseReason: "用户终止任务",
    activeJobId: undefined,
    planSummary: undefined,
    currentTaskId: undefined,
    tasks: session.tasks.map((task) => {
      if (task.status === "running" || task.id === currentTaskId) {
        return {
          ...task,
          status: "failed" as const,
          error: "用户终止",
          failedPhase: "已终止",
        };
      }
      return task;
    }),
  });
  await emitSession(next);
}

function waitForUserGate(expected: "execute" | "merge" | "reply"): Promise<UserGate> {
  userGateExpected = expected;
  return new Promise((resolve) => {
    userGateResolve = (gate) => {
      userGateResolve = null;
      userGateExpected = null;
      resolve(gate);
    };
  });
}

function updateTask(current: TapdBatchSession, taskId: string, patch: Partial<TapdBatchTask>): TapdBatchSession {
  return touchSession({
    ...current,
    tasks: current.tasks.map((task) => (task.id === taskId ? { ...task, ...patch } : task)),
  });
}

async function runSingleTask(
  current: TapdBatchSession,
  task: TapdBatchTask,
  resumeJobId?: string
): Promise<TapdBatchSession> {
  const existingJobId = resumeJobId ?? task.jobId;
  let jobId = existingJobId;
  let startedAt = Date.now();

  let next = touchSession({
    ...updateTask(current, task.id, {
      status: "running",
      error: undefined,
      failedPhase: undefined,
      ...(jobId ? {} : { jobId: undefined }),
    }),
    status: "running",
    currentTaskId: task.id,
    activeJobId: jobId,
    planSummary: jobId ? current.planSummary : undefined,
    pauseReason: undefined,
  });
  await emitSession(next);

  if (!jobId) {
    await loadPersistedServerUrl();
    const prepared = await prepareTapdJobImages(serverUrl, task.sourceHtml, current.workspaceId);
    if (prepared.downloadFailed) {
      return touchSession({
        ...updateTask(next, task.id, {
          status: "failed",
          error: "配图下载或处理失败",
          failedPhase: "配图",
        }),
        status: "paused",
        pauseReason: `${task.title}：描述中有 ${prepared.expectedInHtml} 张配图但下载失败。请重启服务端后重试；若仍失败，请在浏览器登录 tapd.cn 后再跑任务`,
      });
    }

    const prompt = appendTapdImageInstructions(task.prompt, prepared.images.length);
    const plan = await submitPlan(serverUrl, {
      prompt,
      submittedBy: "tapd-batch",
      images: prepared.images.length > 0 ? prepared.images : undefined,
    });
    jobId = plan.jobId;
    startedAt = Date.now();

    await clearJobLog(jobId);
    attachJobStream(jobId);

    next = touchSession({
      ...updateTask(next, task.id, { jobId }),
      activeJobId: jobId,
    });
    await emitSession(next);
  } else {
    attachJobStream(jobId);
  }

  let job = await queryJobStatus(serverUrl, jobId);

  if (job.status === "planning") {
    job = await waitForJobStatus(jobId, ["awaiting_confirm", "awaiting_input", "failed", "cancelled"], startedAt);
  } else if (job.status === "pending" || job.status === "running") {
    job = await waitForJobStatus(jobId, ["awaiting_merge", "failed", "cancelled", "completed"], startedAt);
  }

  while (job.status === "awaiting_input" || job.status === "awaiting_confirm") {
    if (job.status === "awaiting_input") {
      next = touchSession({
        ...next,
        status: "waiting_input",
        activeJobId: jobId,
        planSummary: job.planSummary,
        pauseReason: `${task.title}：需要补充信息`,
      });
      await emitSession(next);

      const inputGate = await waitForUserGate("reply");
      if (inputGate === "cancel") {
        if (batchCancelled) return session ?? next;
        await cancelJob(serverUrl, jobId);
        return touchSession({
          ...updateTask(next, task.id, { status: "failed", error: "用户取消", failedPhase: "已取消" }),
          status: "paused",
          pauseReason: `${task.title}：已取消`,
        });
      }

      const reply = pendingPlanReply.trim();
      pendingPlanReply = "";
      if (!reply) continue;

      try {
        await replyToPlan(serverUrl, jobId, reply);
      } catch (err) {
        return handlePlanReplyError(next, task, err);
      }
      next = touchSession({ ...next, status: "running", planSummary: undefined, pauseReason: undefined });
      await emitSession(next);
      job = await waitForJobStatus(jobId, ["awaiting_confirm", "awaiting_input", "failed", "cancelled"], startedAt);
      continue;
    }

    if (!job.planSummary?.trim()) {
      job = await queryJobStatus(serverUrl, jobId);
    }
    next = touchSession({
      ...next,
      status: "waiting_confirm",
      activeJobId: jobId,
      planSummary: job.planSummary,
      pauseReason: undefined,
    });
    await emitSession(next);

    const gate = await waitForUserGate("execute");
    if (gate === "cancel") {
      if (batchCancelled) return session ?? next;
      await cancelJob(serverUrl, jobId);
      return touchSession({
        ...updateTask(next, task.id, { status: "failed", error: "用户取消", failedPhase: "已取消" }),
        status: "paused",
        pauseReason: `${task.title}：已取消`,
      });
    }

    if (gate === "reply") {
      const reply = pendingPlanReply.trim();
      pendingPlanReply = "";
      if (!reply) continue;
      try {
        await replyToPlan(serverUrl, jobId, reply);
      } catch (err) {
        return handlePlanReplyError(next, task, err);
      }
      next = touchSession({ ...next, status: "running", planSummary: undefined });
      await emitSession(next);
      job = await waitForJobStatus(jobId, ["awaiting_confirm", "awaiting_input", "failed", "cancelled"], startedAt);
      continue;
    }

    const planSummary = (pendingPlanSummary || job.planSummary || "").trim();
    pendingPlanSummary = "";
    if (!planSummary) {
      return touchSession({
        ...updateTask(next, task.id, { status: "failed", error: "Plan 方案为空", failedPhase: "Plan" }),
        status: "paused",
        pauseReason: `${task.title}：Plan 方案为空`,
      });
    }

    next = touchSession({ ...next, status: "running", pauseReason: undefined });
    await emitSession(next);
    await executeJob(serverUrl, jobId, planSummary);
    job = await waitForJobStatus(jobId, ["awaiting_merge", "failed", "cancelled", "completed"], startedAt);
    break;
  }

  if (job.status === "failed" || job.status === "cancelled") {
    return touchSession({
      ...updateTask(next, task.id, {
        status: "failed",
        error: job.error || job.message || job.status,
        failedPhase: job.status,
      }),
      status: "paused",
      pauseReason: `${task.title}：${job.error || job.message || "执行失败"}`,
    });
  }

  if (job.status === "completed") {
    await markTapdTaskCompleted(task.tapdTaskId);
    return touchSession({
      ...updateTask(next, task.id, {
        status: "completed",
        completedAt: new Date().toISOString(),
      }),
      activeJobId: undefined,
      planSummary: undefined,
    });
  }

  if (job.status === "awaiting_merge") {
    next = touchSession({
      ...next,
      status: "waiting_merge",
      activeJobId: jobId,
      pauseReason: undefined,
    });
    await emitSession(next);

    const gate = await waitForUserGate("merge");
    if (gate === "cancel") {
      if (batchCancelled) return session ?? next;
      await discardMerge(serverUrl, jobId);
      return touchSession({
        ...updateTask(next, task.id, { status: "failed", error: "已放弃合并", failedPhase: "合并" }),
        status: "paused",
        pauseReason: `${task.title}：已放弃合并`,
      });
    }

    next = touchSession({ ...next, status: "running" });
    await emitSession(next);
    await mergeJob(serverUrl, jobId);
    job = await waitForJobStatus(jobId, ["completed", "failed", "cancelled"], startedAt);
  }

  if (job.status === "completed") {
    await markTapdTaskCompleted(task.tapdTaskId);
    return touchSession({
      ...updateTask(next, task.id, {
        status: "completed",
        completedAt: new Date().toISOString(),
      }),
      activeJobId: undefined,
      planSummary: undefined,
    });
  }

  return touchSession({
    ...updateTask(next, task.id, {
      status: "failed",
      error: job.error || job.message || job.status,
      failedPhase: job.status,
    }),
    status: "paused",
    pauseReason: `${task.title}：${job.error || job.message || "失败"}`,
  });
}

async function runBatchLoop(
  initial: TapdBatchSession,
  options?: { resume?: boolean }
): Promise<void> {
  if (loopRunning) return;
  loopRunning = true;
  stopRequested = false;
  batchCancelled = false;

  let current =
    options?.resume && session
      ? touchSession(session)
      : touchSession({ ...initial, status: "running", pauseReason: undefined });

  if (!options?.resume) {
    await emitSession(current);
  }

  const startTaskId = current.currentTaskId;
  const startIndex = startTaskId
    ? current.tasks.findIndex((task) => task.id === startTaskId)
    : current.tasks.findIndex(
        (task) => task.status === "pending" || task.status === "running" || task.status === "failed"
      );

  let resumeActiveJob = Boolean(options?.resume);

  try {
    for (let index = Math.max(0, startIndex); index < current.tasks.length; index += 1) {
      if (stopRequested) {
        if (batchCancelled) return;
        current = touchSession({ ...current, status: "paused", pauseReason: "用户暂停" });
        await emitSession(current);
        return;
      }

      const task = current.tasks[index];
      if (!task || task.status === "completed" || task.status === "skipped") continue;
      if (task.status === "failed" && task.id !== current.currentTaskId) continue;

      const resumeJobId =
        resumeActiveJob && (current.activeJobId || task.jobId)
          ? current.activeJobId ?? task.jobId
          : undefined;
      resumeActiveJob = false;

      current = await runSingleTask(current, task, resumeJobId);
      if (batchCancelled) return;
      await emitSession(current);

      if (
        current.status === "paused" ||
        current.status === "waiting_input" ||
        current.status === "waiting_confirm" ||
        current.status === "waiting_merge"
      ) {
        return;
      }
    }

    current = touchSession({
      ...current,
      status: "completed",
      currentTaskId: undefined,
      activeJobId: undefined,
      pauseReason: undefined,
    });
    await emitSession(current);
  } catch (err) {
    if (!batchCancelled) {
      current = touchSession({
        ...current,
        status: "paused",
        pauseReason: err instanceof Error ? err.message : "任务异常中断",
      });
      await emitSession(current);
    }
  } finally {
    loopRunning = false;
    closeEventStream();
  }
}

export function getTapdBatchControllerState(): TapdBatchSession | null {
  return session;
}

export function isTapdBatchLoopRunning(): boolean {
  return loopRunning;
}

function isJobNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /任务不存在|分析任务不存在|404/.test(msg);
}

async function handlePlanReplyError(
  current: TapdBatchSession,
  task: TapdBatchTask,
  err: unknown
): Promise<TapdBatchSession> {
  if (isJobNotFoundError(err)) {
    return touchSession({
      ...updateTask(current, task.id, {
        jobId: undefined,
        status: "failed",
        error: "服务端任务已过期",
        failedPhase: "Plan",
      }),
      status: "paused",
      activeJobId: undefined,
      planSummary: undefined,
      pauseReason: `${task.title}：服务端任务已过期，请点「重试当前」`,
    });
  }
  throw err;
}

async function directPlanReply(reply: string): Promise<{ ok: boolean; error?: string }> {
  if (!session?.activeJobId || !session.currentTaskId) {
    return { ok: false, error: "无活动任务，请点「重试当前」" };
  }
  await loadPersistedServerUrl();
  if (!serverUrl) {
    return { ok: false, error: "未配置服务端地址" };
  }

  const replyText = reply.trim();
  if (!replyText) {
    return { ok: false, error: "补充说明不能为空" };
  }

  const jobId = session.activeJobId;
  const taskId = session.currentTaskId;
  const task = session.tasks.find((item) => item.id === taskId);
  if (!task) {
    return { ok: false, error: "当前任务不存在" };
  }

  try {
    await replyToPlan(serverUrl, jobId, replyText);
  } catch (err) {
    const next = await handlePlanReplyError(session, task, err);
    await emitSession(next);
    return {
      ok: false,
      error: isJobNotFoundError(err)
        ? "服务端任务已过期（可能已重启），请点「重试当前」"
        : err instanceof Error
          ? err.message
          : String(err),
    };
  }

  const next = touchSession({
    ...session,
    status: "running",
    planSummary: undefined,
    pauseReason: undefined,
  });
  await emitSession(next);

  if (!loopRunning) {
    void runBatchLoop(next, { resume: true });
  }
  return { ok: true };
}

async function directDiscardMerge(): Promise<{ ok: boolean; error?: string }> {
  if (!session?.activeJobId) {
    return { ok: false, error: "无活动任务" };
  }
  await loadPersistedServerUrl();
  if (!serverUrl) {
    return { ok: false, error: "未配置服务端地址" };
  }

  const jobId = session.activeJobId;
  const taskId = session.currentTaskId;
  const taskTitle = taskId ? session.tasks.find((item) => item.id === taskId)?.title : undefined;

  try {
    await discardMerge(serverUrl, jobId);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  let next = session;
  if (taskId) {
    next = touchSession({
      ...updateTask(session, taskId, {
        status: "failed",
        error: "已放弃合并",
        failedPhase: "合并",
      }),
      status: "paused",
      pauseReason: `${taskTitle ?? "任务"}：已放弃合并`,
      activeJobId: undefined,
      planSummary: undefined,
    });
  } else {
    next = touchSession({
      ...session,
      status: "paused",
      pauseReason: "已放弃合并",
      activeJobId: undefined,
      planSummary: undefined,
    });
  }
  await emitSession(next);
  return { ok: true };
}

async function directConfirmMerge(): Promise<{ ok: boolean; error?: string }> {
  if (!session?.activeJobId || !session.currentTaskId) {
    return { ok: false, error: "无活动任务" };
  }
  await loadPersistedServerUrl();
  if (!serverUrl) {
    return { ok: false, error: "未配置服务端地址" };
  }

  const jobId = session.activeJobId;
  const taskId = session.currentTaskId;
  const task = session.tasks.find((item) => item.id === taskId);
  if (!task) {
    return { ok: false, error: "当前任务不存在" };
  }

  let next = touchSession({ ...session, status: "running", pauseReason: undefined });
  await emitSession(next);

  try {
    await mergeJob(serverUrl, jobId);
    const job = await waitForJobStatus(jobId, ["completed", "failed", "cancelled"], Date.now());
    if (job.status === "completed") {
      await markTapdTaskCompleted(task.tapdTaskId);
      next = touchSession({
        ...updateTask(next, taskId, {
          status: "completed",
          completedAt: new Date().toISOString(),
        }),
        activeJobId: undefined,
        planSummary: undefined,
      });
      await emitSession(next);
      if (!loopRunning) {
        void runBatchLoop(next, { resume: true });
      }
      return { ok: true };
    }

    next = touchSession({
      ...updateTask(next, taskId, {
        status: "failed",
        error: job.error || job.message || job.status,
        failedPhase: job.status,
      }),
      status: "paused",
      pauseReason: `${task.title}：${job.error || job.message || "合并失败"}`,
    });
    await emitSession(next);
    return { ok: false, error: job.error || job.message || "合并失败" };
  } catch (err) {
    next = touchSession({
      ...updateTask(next, taskId, {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        failedPhase: "合并",
      }),
      status: "paused",
      pauseReason: `${task.title}：合并失败`,
    });
    await emitSession(next);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function handleTapdBatchCommand(
  command: import("./tapdBatchMessages.js").TapdBatchCommand
): Promise<unknown> {
  switch (command.type) {
    case "TAPD_BATCH_GET_STATE":
      await ensureSessionLoaded();
      await loadPersistedServerUrl();
      return { session, loopRunning };

    case "TAPD_BATCH_RESUME":
      await resumeBatchLoopIfNeeded(command.serverUrl);
      await ensureSessionLoaded();
      return { session, loopRunning };

    case "TAPD_BATCH_START":
      await persistServerUrl(command.serverUrl);
      void runBatchLoop(command.session);
      return { ok: true };

    case "TAPD_BATCH_PAUSE":
      stopRequested = true;
      return { ok: true };

    case "TAPD_BATCH_CANCEL":
      await cancelBatchSession();
      return { ok: true };

    case "TAPD_BATCH_CONFIRM_EXECUTE":
      pendingPlanSummary = command.planSummary;
      if (userGateExpected === "execute") userGateResolve?.("execute");
      return { ok: true };

    case "TAPD_BATCH_PLAN_REPLY":
      pendingPlanReply = command.reply;
      if (userGateExpected === "reply" || userGateExpected === "execute") {
        userGateResolve?.("reply");
        return { ok: true };
      }
      return directPlanReply(command.reply);

    case "TAPD_BATCH_CONFIRM_MERGE":
      if (userGateExpected === "merge") {
        userGateResolve?.("execute");
        return { ok: true };
      }
      return directConfirmMerge();

    case "TAPD_BATCH_DISCARD_MERGE":
      if (userGateExpected === "merge") {
        userGateResolve?.("cancel");
        return { ok: true };
      }
      return directDiscardMerge();

    case "TAPD_BATCH_SKIP_CURRENT": {
      if (!session?.currentTaskId) return { ok: false };
      const taskId = session.currentTaskId;
      const next = touchSession({
        ...session,
        status: "running",
        pauseReason: undefined,
        tasks: session.tasks.map((task) =>
          task.id === taskId ? { ...task, status: "skipped", error: undefined, failedPhase: undefined } : task
        ),
      });
      userGateResolve?.("cancel");
      await emitSession(next);
      void runBatchLoop(next);
      return { ok: true };
    }

    case "TAPD_BATCH_RETRY_CURRENT": {
      if (!session) return { ok: false };
      const taskId = session.currentTaskId ?? session.tasks.find((t) => t.status === "failed")?.id;
      if (!taskId) return { ok: false };
      const next = touchSession({
        ...session,
        status: "running",
        pauseReason: undefined,
        tasks: session.tasks.map((task) =>
          task.id === taskId
            ? { ...task, status: "pending", error: undefined, failedPhase: undefined, jobId: undefined }
            : task
        ),
      });
      await emitSession(next);
      void runBatchLoop(next);
      return { ok: true };
    }

    default:
      return { ok: false };
  }
}

export async function initTapdBatchControllerFromStorage(): Promise<void> {
  await loadPersistedServerUrl();
  session = await loadTapdBatchSession();
  if (shouldAutoResumeSession(session)) {
    void resumeBatchLoopIfNeeded();
  }
}

export async function loadJobLogForReplay(jobId: string): Promise<JobEvent[]> {
  const stored = await chrome.storage.local.get([TAPD_BATCH_JOB_LOG]);
  const current = stored[TAPD_BATCH_JOB_LOG] as { jobId: string; events: JobEvent[] } | undefined;
  if (current?.jobId === jobId && current.events.length > 0) return current.events;
  if (!serverUrl) return [];
  try {
    return await fetchJobEvents(serverUrl, jobId);
  } catch {
    return [];
  }
}
