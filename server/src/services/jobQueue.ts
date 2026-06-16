import { getJob, updateJob } from "./jobStore.js";
import { processJob } from "./jobProcessor.js";
import { appendJobEvent, type QueueItemSummary } from "./jobEvents.js";

function queueMessage(jobsAhead: number): string {
  if (jobsAhead <= 0) return "即将开始处理...";
  return `排队中，前面还有 ${jobsAhead} 个任务`;
}

function summarizeJob(jobId: string, jobsAhead: number): QueueItemSummary | null {
  const job = getJob(jobId);
  if (!job) return null;
  return {
    jobId,
    prompt: job.prompt.length > 60 ? `${job.prompt.slice(0, 60)}…` : job.prompt,
    jobsAhead,
  };
}

class JobQueue {
  private readonly waiting: string[] = [];
  private processing = false;
  private currentJobId: string | null = null;

  /** 入队并返回前面还有多少任务（含正在执行的） */
  enqueue(jobId: string): number {
    const jobsAhead = (this.currentJobId ? 1 : 0) + this.waiting.length;
    this.waiting.push(jobId);
    this.syncWaitingJobs();
    this.broadcastQueue(jobId);
    void this.pump();
    return jobsAhead;
  }

  /** 从等待队列移除（已在执行中的无法移除） */
  dequeue(jobId: string): boolean {
    const idx = this.waiting.indexOf(jobId);
    if (idx === -1) return false;
    this.waiting.splice(idx, 1);
    this.syncWaitingJobs();
    this.broadcastQueueForAll();
    return true;
  }

  getJobsAhead(jobId: string): number | null {
    if (this.currentJobId === jobId) return 0;
    const index = this.waiting.indexOf(jobId);
    if (index === -1) return null;
    return (this.currentJobId ? 1 : 0) + index;
  }

  getSnapshot(): { running: boolean; currentJobId: string | null; waiting: number } {
    return {
      running: this.processing,
      currentJobId: this.currentJobId,
      waiting: this.waiting.length,
    };
  }

  getQueuePayload(forJobId: string): {
    jobsAhead: number;
    running: QueueItemSummary | null;
    waiting: QueueItemSummary[];
  } {
    const jobsAhead = this.getJobsAhead(forJobId) ?? 0;
    const running =
      this.currentJobId != null ? summarizeJob(this.currentJobId, 0) : null;

    const waiting = this.waiting
      .map((jobId, index) => {
        const ahead = (this.currentJobId ? 1 : 0) + index;
        return summarizeJob(jobId, ahead);
      })
      .filter((item): item is QueueItemSummary => item != null);

    return { jobsAhead, running, waiting };
  }

  broadcastQueue(forJobId: string): void {
    const payload = this.getQueuePayload(forJobId);
    appendJobEvent(forJobId, {
      type: "queue",
      jobsAhead: payload.jobsAhead,
      running: payload.running,
      waiting: payload.waiting,
      text:
        payload.jobsAhead > 0
          ? `排队中，前面还有 ${payload.jobsAhead} 个任务`
          : "即将开始处理...",
    });
  }

  broadcastQueueForAll(): void {
    const ids = new Set<string>();
    if (this.currentJobId) ids.add(this.currentJobId);
    for (const jobId of this.waiting) ids.add(jobId);
    for (const jobId of ids) {
      this.broadcastQueue(jobId);
    }
  }

  private syncWaitingJobs(): void {
    const aheadBase = this.currentJobId ? 1 : 0;
    this.waiting.forEach((jobId, index) => {
      const job = getJob(jobId);
      if (!job || job.status !== "pending") return;

      const jobsAhead = aheadBase + index;
      updateJob(jobId, {
        jobsAhead,
        message: queueMessage(jobsAhead),
      });
    });
  }

  private async pump(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      while (this.waiting.length > 0) {
        const jobId = this.waiting.shift()!;
        const job = getJob(jobId);
        if (!job || job.status === "cancelled") {
          continue;
        }
        this.currentJobId = jobId;
        this.syncWaitingJobs();
        this.broadcastQueueForAll();

        try {
          await processJob(jobId);
        } catch (err) {
          console.error(`[JobQueue ${jobId}] 处理异常:`, err);
        } finally {
          this.currentJobId = null;
          this.broadcastQueueForAll();
        }
      }
    } finally {
      this.processing = false;
      if (this.waiting.length > 0) {
        void this.pump();
      }
    }
  }
}

export const jobQueue = new JobQueue();
