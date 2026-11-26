import type { WSClient } from "@wecom/aibot-node-sdk";
import { reply, type MessageFrame } from "./client.js";
import { formatProgress, progressStage, milestoneSignature, latestAgentActivity } from "./replies.js";
import { logOperation } from "../../services/operationLog.js";
import { getJob } from "../../services/jobStore.js";
import { getJobEvents } from "../../services/jobEvents.js";
import { areJobNoticesSilent } from "./sessionStore.js";
import { isJobReverting } from "./dialogueStore.js";

interface LiveResponse {
  stream: { frame: MessageFrame; id: string };
  target: string;
  started: number;
  tail: Promise<void>;
  closed: boolean;
  lastUpdate: number;
  lastStage: string;
  lastActivity: string;
}

export class ResponseCoordinator {
  private live = new Map<string, LiveResponse>();
  private blocks = new Map<string, number>();
  private timer: ReturnType<typeof setInterval>;
  constructor(private client: WSClient, private lifetimeMs = 300_000, private now = Date.now) {
    this.timer = setInterval(() => { void this.refresh(); }, 10_000);
    this.timer.unref();
  }
  block(target: string): () => void {
    this.blocks.set(target, (this.blocks.get(target) ?? 0) + 1);
    return () => { this.blocks.set(target, Math.max(0, (this.blocks.get(target) ?? 1) - 1)); };
  }
  blocked(target: string): boolean { return (this.blocks.get(target) ?? 0) > 0; }
  track(jobId: string, frame: MessageFrame, streamId: string, target: string, started = this.now()): void {
    this.live.set(jobId, { stream: { frame, id: streamId }, target, started, tail: Promise.resolve(),
      closed: false, lastUpdate: -Infinity, lastStage: "", lastActivity: "" });
  }
  start(jobId: string, frame: MessageFrame, streamId: string, target: string, started: number, text: string,
    ready: Promise<void>): void {
    this.track(jobId, frame, streamId, target, started);
    const live = this.live.get(jobId)!;
    live.lastUpdate = this.now();
    live.tail = ready.then(async () => { await this.client.replyStream(frame, streamId, text, false); }).catch(error => {
      live.closed = true;
      const detail = error && typeof error === "object" && "errcode" in error
        ? `${error.errcode}: ${"errmsg" in error ? error.errmsg : ""}` : String(error);
      logOperation({ action: "wecom_progress_stream", status: "failed", jobId, error: detail });
    });
  }
  async finish(jobId: string, text: string): Promise<boolean> {
    const live = this.live.get(jobId);
    if (!live) return false;
    this.live.delete(jobId);
    await live.tail;
    if (live.closed || this.now() - live.started >= this.lifetimeMs) return false;
    try {
      await reply(this.client, live.stream.frame, text, live.stream.id);
      return true;
    } catch {
      return false;
    }
  }
  async refresh(): Promise<void> {
    for (const [jobId, live] of this.live) {
      if (this.blocked(live.target)) continue;
      if (areJobNoticesSilent(jobId)) { this.live.delete(jobId); continue; }
      if (live.closed) continue;
      const job = getJob(jobId);
      const events = getJobEvents(jobId);
      let phase = [...events].reverse().find(event => event.type === "stage" && event.phase)?.phase;
      const reverting = isJobReverting(jobId);
      if (reverting && phase !== "default_revert") phase = "revert_wait";
      if (job && milestoneSignature(job) && !reverting) continue;
      const now = this.now();
      const stage = progressStage(job, phase);
      const activity = latestAgentActivity(events);
      const changed = stage !== live.lastStage || activity !== live.lastActivity;
      const text = formatProgress(job, phase, activity);
      if (now - live.lastUpdate < 10_000 || (!changed && now - live.started < this.lifetimeMs)) continue;
      live.lastUpdate = now;
      live.tail = live.tail.then(async () => {
        if (this.live.get(jobId) !== live || live.closed || this.blocked(live.target) || areJobNoticesSilent(jobId)) return;
        const stream = live.stream;
        if (now - live.started >= this.lifetimeMs) {
          // Close before WeCom's stream deadline; only the final result is sent separately.
          live.closed = true;
          await reply(this.client, stream.frame, `${text}\n结果稍后通知你。`, stream.id);
        } else await this.client.replyStream(stream.frame, stream.id, text, false);
        live.lastStage = stage;
        live.lastActivity = activity;
      }).catch(() => {});
      await live.tail;
    }
  }
  stop(): void { clearInterval(this.timer); this.live.clear(); this.blocks.clear(); }
}
