import { randomUUID } from "node:crypto";
import type { Job, JobAttachment } from "../../types.js";
import type { JobEventInput } from "../jobEvents.js";
import { isWorkbenchCancellation, isWorkbenchResetRequest } from "./protocol.js";
import { workbenchTransitions } from "./transitions.js";
import type { createWorkbenchWorker, WorkbenchWorkerDependencies } from "./worker.js";
import { chatQuickReply } from "../chatQuickReply.js";

export interface WorkbenchControllerDependencies extends Pick<WorkbenchWorkerDependencies, "get" | "update"> {
  worker: ReturnType<typeof createWorkbenchWorker>;
  kill: (id: string) => unknown;
  event: (id: string, event: JobEventInput) => void;
}

export function createWorkbenchController(deps: WorkbenchControllerDependencies) {
  const { worker } = deps;
  function assertWorkbenchCanReceive(jobId: string): Job {
    const job = deps.get(jobId);
    if (!job) throw new Error("任务不存在");
    if (!job.workbenchSession && ["planning", "running", "pending"].includes(job.status)) throw new Error("原任务仍在执行，请结束后进入持续对话");
    if (job.workbenchSession && !worker.isRunning(jobId) && ["pending", "running"].includes(job.status)) throw new Error("正在处理代码合并，请完成后再发送消息");
    return job;
  }
  function receiveWorkbenchMessage(jobId: string, text: string, attachments: JobAttachment[] = []): void {
    const job = assertWorkbenchCanReceive(jobId);
    text = text.trim();
    if (!text || text.length > 20000) throw new Error("消息应为 1–20000 个字符");
    const attachmentIndexes = attachments.length ? attachments.map((_, index) => (job.attachments?.length ?? 0) + index) : !job.workbenchMessages?.length ? (job.attachments ?? []).map((_, index) => index) : [];
    const messages = [...(job.workbenchMessages ?? []), { id: randomUUID(), role: "user" as const, text, createdAt: new Date().toISOString(), attachmentIndexes }];
    const inputCount = (job.workbenchMessages ?? []).filter(message => message.role === "user").length;
    // Do not consume a business answer, bypass an image, resume paused work,
    // or advance an actor's input counter while it is still processing a turn.
    const quick = !worker.isRunning(jobId) && !job.workbenchNeedsInput && !job.clarificationQuestions?.length
      && inputCount === (job.workbenchProcessedInputs ?? 0) && !attachmentIndexes.length
      ? chatQuickReply(text, "workbench") : undefined;
    if (quick) {
      deps.update(jobId, { workbenchSession: true, workbenchMessages: [...messages,
        { id: randomUUID(), role: "assistant", text: quick, createdAt: new Date().toISOString(), attachmentIndexes: [] }],
        workbenchProcessedInputs: inputCount + 1 });
      deps.event(jobId, { type: "user", text });
      deps.event(jobId, { type: "stage", phase: "session_reply", text: quick });
      return;
    }
    if (job.workbenchAnalysisOnly && /^(?:请)?(?:开始|继续)(?:修改|实现|开发|处理)/.test(text)) deps.update(jobId, { workbenchAnalysisOnly: false });
    const cancelling = isWorkbenchCancellation(text) || isWorkbenchResetRequest(text);
    const deferredResume = (job.workbenchPauseRequested || cancelling) && worker.isRunning(jobId);
    deps.update(jobId, { workbenchSession: true, workbenchMessages: messages, workbenchPauseRequested: Boolean(deferredResume), attachments: [...(job.attachments ?? []), ...attachments] });
    if (deferredResume) worker.resumeAfterPause(jobId);
    if (cancelling && worker.isRunning(jobId)) deps.kill(jobId);
    deps.event(jobId, { type: "user", text, attachmentCount: attachments.length || undefined });
    void worker.start(jobId);
  }
  function pauseWorkbenchSession(jobId: string): void {
    const job = deps.get(jobId);
    if (!job?.workbenchSession || !worker.isRunning(jobId)) throw new Error("当前没有正在执行的会话");
    deps.update(jobId, workbenchTransitions.pause());
    deps.kill(jobId);
    deps.event(jobId, { type: "stage", phase: "session_paused", text: "已停止，工作区已保留。发送消息可以继续。" });
  }

  return { assertWorkbenchCanReceive, receiveWorkbenchMessage, pauseWorkbenchSession };
}
