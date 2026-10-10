import type { WSClient } from "@wecom/aibot-node-sdk";
import { reply, type MessageFrame } from "./client.js";
import { formatProgress, progressStage, milestoneSignature, latestAgentActivity } from "./replies.js";
import { getJob } from "../../services/jobStore.js";
import { getJobEvents } from "../../services/jobEvents.js";
import { areJobNoticesSilent } from "./sessionStore.js";
import { isJobReverting } from "./dialogueStore.js";

interface LiveResponse {
  frame: MessageFrame;
  streamId: string;
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
  constructor(private client: WSClient, private lifetimeMs = 90_000, private now = Date.now) {
    this.timer = setInterval(() => { void this.refresh(); }, 10_000);
    this.timer.unref();
  }
  block(target: string): () => void {
    this.blocks.set(target, (this.blocks.get(target) ?? 0) + 1);
    return () => { this.blocks.set(target, Math.max(0, (this.blocks.get(target) ?? 1) - 1)); };
  }
  blocked(target: string): boolean { return (this.blocks.get(target) ?? 0) > 0; }
  track(jobId: string, frame: MessageFrame, streamId: string, target: string): void {
    this.live.set(jobId, { frame, streamId, target, started: this.now(), tail: Promise.resolve(),
      closed: false, lastUpdate: -Infinity, lastStage: "", lastActivity: "" });
  }
  async finish(jobId: string, text: string): Promise<boolean> {
    const live = this.live.get(jobId);
    if (!live) return false;
    this.live.delete(jobId);
    await live.tail;
    if (live.closed) return false;
    await reply(this.client, live.frame, text, live.streamId);
    return true;
  }
  async refresh(): Promise<void> {
    for (const [jobId, live] of this.live) {
      if (this.blocked(live.target)) continue;
      if (areJobNoticesSilent(jobId)) { this.live.delete(jobId); continue; }
      const job = getJob(jobId);
      const events = getJobEvents(jobId);
      let phase = [...events].reverse().find(event => event.type === "stage" && event.phase)?.phase;
      const reverting = isJobReverting(jobId);
      if (reverting && phase !== "default_revert") phase = "revert_wait";
      if (job && milestoneSignature(job) && !reverting) continue;
      const now = this.now();
      const stage = progressStage(job, phase);
      const activity = latestAgentActivity(events);
      const text = formatProgress(job, phase) + (activity ? `\n当前：${activity}` : "");
      if (live.closed) {
        // Long analysis phases also need feedback: coalesce actual activity and heartbeat once a minute.
        const changed = stage !== live.lastStage || activity !== live.lastActivity;
        if (now - live.lastUpdate < (changed ? 30_000 : 60_000)) continue;
      } else if (now - live.lastUpdate < 10_000) continue;
      live.lastUpdate = now;
      live.tail = live.tail.then(async () => {
        if (this.live.get(jobId) !== live || this.blocked(live.target) || areJobNoticesSilent(jobId)) return;
        if (live.closed) {
          const title = job?.prompt.slice(0, 60);
          await this.client.sendMessage(live.target, { msgtype: "markdown", markdown: { content: title ? `进度：${title}\n${text}` : text } });
        } else if (now - live.started >= this.lifetimeMs) {
          // Retain tracking for coarse later updates; the persisted outbox still owns final results.
          live.closed = true;
          await reply(this.client, live.frame, `${text}\n结果稍后通知你。`, live.streamId);
        } else await this.client.replyStream(live.frame, live.streamId, text, false);
        live.lastStage = stage;
        live.lastActivity = activity;
      }).catch(() => {});
      await live.tail;
    }
  }
  stop(): void { clearInterval(this.timer); this.live.clear(); this.blocks.clear(); }
}
