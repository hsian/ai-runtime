import { getWecomConfig } from "./config.js";
import { createWecomClient } from "./client.js";
import { createDirectMessageHandler } from "./directMessageHandler.js";
import { initWecomStore, listBindings, queueNotice, pendingNotices, acknowledgeChunk, areJobNoticesSilent, recordFinalAnswer } from "./sessionStore.js";
import { getJob } from "../../services/jobStore.js";
import { subscribeJobEvents } from "../../services/jobEvents.js";
import { formatJob, jobNoticeTitle, milestoneSignature, splitMessage } from "./replies.js";
import { ResponseCoordinator } from "./responseCoordinator.js";
import { getDatabase } from "../../services/database.js";
import { getDialogue } from "./dialogueStore.js";
import type { WecomSession } from "./types.js";
import type { WecomConfig } from "./config.js";
import { startTapdCompletionMonitor } from "./tapdCompletion.js";
import { createWorkbenchBridge } from "./workbenchBridge.js";
import type { Job } from "../../types.js";
import { getProject } from "../../services/projectRegistry.js";

function formatNotice(job: Job): string {
  const title = jobNoticeTitle(job);
  const text = job.status === "failed" ? "这次任务没完成。你可以继续问我具体进度，或说明要不要再试。"
    : job.status === "awaiting_merge" ? `代码已修改，尚未合并到 ${getProject(job.projectId).defaultBranch}。`
      + (job.mergeRetryable ? "上次合并没有成功。" : "")
      : formatJob({ ...job, previewUrl: undefined, previewMessage: undefined });
  return title ? `**${title}**\n\n${text}` : text;
}

export function startWecomBot(options: WecomConfig | undefined = getWecomConfig(), clientFactory = createWecomClient): () => void {
  if (!options) return () => {};
  initWecomStore();
  const client = clientFactory(options);
  const responses = new ResponseCoordinator(client);
  const workbench = createWorkbenchBridge(options,
    (target, content) => client.sendMessage(target, { msgtype: "markdown", markdown: { content } }),
    target => authenticated && !stopped && !responses.blocked(target));
  const handler = createDirectMessageHandler(client, options, responses);
  const subscriptions = new Map<string, () => void>();
  const retryAfter = new Map<string, number>();
  let authenticated = false;
  let stopped = false;
  let flushing = false;
  const stopCompletionMonitor = options.tapdCompletion ? startTapdCompletionMonitor(options.botId, options.tapdCompletion,
    target => authenticated && !stopped && (!target || !responses.blocked(target)),
    (target, content) => client.sendMessage(target, { msgtype: "markdown", markdown: { content } })) : () => {};
  const reconcile = () => {
    const bindings = listBindings();
    const existing = new Set(bindings.map(binding => binding.job_id));
    for (const [id, unsubscribe] of subscriptions) {
      if (!existing.has(id)) { unsubscribe(); subscriptions.delete(id); }
    }
    for (const binding of bindings) {
      const notice = () => {
        const job = getJob(binding.job_id);
        if (!job) return;
        const session = getDatabase().prepare("SELECT * FROM wecom_sessions WHERE session_key = ?").get(binding.session_key) as WecomSession;
        const flow = getDialogue({ ...session, conversation_id: job.conversationId ?? session.conversation_id });
        if (flow?.sourceJobId === job.jobId && flow.step === "reverting") return;
        const signature = milestoneSignature(job);
        if (signature) queueNotice(job.jobId, signature, binding.target_id,
           splitMessage(formatNotice(job)));
      };
      notice();
      const job = getJob(binding.job_id);
      if (job && !["completed", "failed", "cancelled"].includes(job.status) && !subscriptions.has(job.jobId)) {
        subscriptions.set(job.jobId, subscribeJobEvents(job.jobId, () => {
          notice();
          void flush();
        }));
      } else if (job && ["completed", "failed", "cancelled"].includes(job.status)) {
        subscriptions.get(job.jobId)?.();
        subscriptions.delete(job.jobId);
      }
    }
  };
  const flush = async () => {
    if (flushing || stopped || !authenticated) return;
    flushing = true;
    try {
      for (const notice of pendingNotices()) {
        if (responses.blocked(notice.target_id)) continue;
        if (Date.now() < (retryAfter.get(notice.target_id) ?? 0)) continue;
        const chunks = JSON.parse(notice.chunks) as string[];
        const job = getJob(notice.job_id);
        const binding = listBindings().find(binding => binding.job_id === notice.job_id);
        const session = binding ? getDatabase().prepare("SELECT * FROM wecom_sessions WHERE session_key = ?")
          .get(binding.session_key) as WecomSession | undefined : undefined;
        if (session && job && getDialogue({ ...session, conversation_id: job.conversationId ?? session.conversation_id })?.step === "reverting") continue;
        if (!job || notice.signature !== milestoneSignature(job) || areJobNoticesSilent(notice.job_id)) {
          acknowledgeChunk(notice.id, chunks.length, chunks.length);
          continue;
        }
        try {
          const text = formatNotice(job);
          if (await responses.finish(notice.job_id, text)) {
            recordFinalAnswer(job.jobId, text);
            acknowledgeChunk(notice.id, chunks.length, chunks.length);
            continue;
          }
          const compactChunks = splitMessage(text);
          if (notice.sent_chunks >= compactChunks.length) acknowledgeChunk(notice.id, compactChunks.length, compactChunks.length);
          for (let i = notice.sent_chunks; i < compactChunks.length; i++) {
            if (stopped || !authenticated) return;
            if (areJobNoticesSilent(notice.job_id)) break;
            await client.sendMessage(notice.target_id, { msgtype: "markdown", markdown: { content: compactChunks[i] } });
            if (stopped) return;
            acknowledgeChunk(notice.id, i + 1, compactChunks.length);
          }
          recordFinalAnswer(job.jobId, text);
          retryAfter.delete(notice.target_id);
        } catch {
          retryAfter.set(notice.target_id, Date.now() + 15_000);
          console.warn("[WeCom] 会话通知发送失败，将稍后重试");
        }
      }
    } catch { console.warn("[WeCom] 结果通知发送失败，将稍后重试"); }
    finally { flushing = false; }
  };
  client.on("authenticated", () => {
    authenticated = true;
    console.log(`[WeCom] 机器人已连接，默认项目：${options.projectId}`);
    reconcile(); workbench.reconcile(); void workbench.flush(); void flush();
  });
  client.on("disconnected", () => { authenticated = false; });
  client.on("error", () => { console.error("[WeCom] 连接异常，请检查网络和机器人配置"); });
  client.on("message", frame => handler.handle(frame));
  client.on("event.template_card_event", frame => handler.handleConfirmation(frame));
  const timer = setInterval(() => {
    if (stopped) return;
    try { reconcile(); workbench.reconcile(); void workbench.flush(); void flush(); }
    catch { console.error("[WeCom] 同步任务状态失败"); }
  }, 3000);
  timer.unref();
  client.connect();
  return () => {
    stopped = true;
    workbench.stop();
    stopCompletionMonitor();
    handler.stop();
    responses.stop();
    clearInterval(timer);
    for (const unsubscribe of subscriptions.values()) unsubscribe();
    subscriptions.clear();
    client.disconnect();
  };
}
