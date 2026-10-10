import type { WSClient } from "@wecom/aibot-node-sdk";
import { reply, type MessageFrame } from "./client.js";
import { THINKING } from "./replies.js";

interface LiveResponse {
  frame: MessageFrame;
  streamId: string;
  target: string;
  started: number;
  tail: Promise<void>;
}

export class ResponseCoordinator {
  private live = new Map<string, LiveResponse>();
  private blocks = new Map<string, number>();
  private timer: ReturnType<typeof setInterval>;
  constructor(private client: WSClient, private lifetimeMs = 90_000) {
    this.timer = setInterval(() => { void this.refresh(); }, 10_000);
    this.timer.unref();
  }
  block(target: string): () => void {
    this.blocks.set(target, (this.blocks.get(target) ?? 0) + 1);
    return () => { this.blocks.set(target, Math.max(0, (this.blocks.get(target) ?? 1) - 1)); };
  }
  blocked(target: string): boolean { return (this.blocks.get(target) ?? 0) > 0; }
  track(jobId: string, frame: MessageFrame, streamId: string, target: string): void {
    this.live.set(jobId, { frame, streamId, target, started: Date.now(), tail: Promise.resolve() });
  }
  async finish(jobId: string, text: string): Promise<boolean> {
    const live = this.live.get(jobId);
    if (!live) return false;
    this.live.delete(jobId);
    await live.tail;
    await reply(this.client, live.frame, text, live.streamId);
    return true;
  }
  async refresh(): Promise<void> {
    for (const [jobId, live] of this.live) {
      if (this.blocked(live.target)) continue;
      if (Date.now() - live.started >= this.lifetimeMs) {
        try { await this.finish(jobId, "仍在处理中，结果稍后通知你。"); }
        catch { /* The persisted outbox will deliver the result. */ }
      } else {
        live.tail = live.tail.then(async () => {
          if (this.live.get(jobId) === live) await this.client.replyStream(live.frame, live.streamId, THINKING, false);
        }).catch(() => {});
        await live.tail;
      }
    }
  }
  stop(): void { clearInterval(this.timer); this.live.clear(); this.blocks.clear(); }
}
