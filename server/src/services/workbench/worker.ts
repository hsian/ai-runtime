import { randomUUID } from "node:crypto";
import type { Job } from "../../types.js";
import { buildWorkbenchRequest, isWorkbenchCancellation, isWorkbenchResetRequest, parseWorkbenchReleaseTarget, type WorkbenchDecision } from "./protocol.js";
import { workbenchTransitions } from "./transitions.js";

export interface WorkbenchRoutingReply { message: string; needsInput: boolean }

export interface WorkbenchWorkerDependencies {
  get: (id: string) => Job | undefined;
  update: (id: string, patch: Partial<Job>) => Job | undefined;
  analyze: (job: Job) => Promise<WorkbenchDecision>;
  route?: (job: Job) => Promise<WorkbenchRoutingReply | undefined>;
  execute: (id: string) => Promise<void>;
  testCases: (id: string) => Promise<void>;
  event: (id: string, phase: string, text: string) => void;
  cancel?: (id: string, reset?: boolean) => Promise<string>;
  release?: (id: string, targetBranch: string) => Promise<string>;
}

/** One actor per job. Messages received during a turn are durably stored and consumed next. */
export function createWorkbenchWorker(deps: WorkbenchWorkerDependencies) {
  const running = new Map<string, Promise<void>>();
  const resumeAfterPause = new Set<string>();
  const pending = (job: Job) => (job.workbenchMessages ?? []).filter(message => message.role === "user").length > (job.workbenchProcessedInputs ?? 0);
  const appendAssistant = (id: string, text: string) => {
    const job = deps.get(id)!;
    deps.update(id, { workbenchMessages: [...(job.workbenchMessages ?? []), { id: randomUUID(), role: "assistant", text, createdAt: new Date().toISOString() }] });
    deps.event(id, "session_reply", text);
  };
  const drive = async (id: string) => {
    while (true) {
      const current = deps.get(id);
      if (!current || current.workbenchPauseRequested || !pending(current)) return;
      const inputCount = (current.workbenchMessages ?? []).filter(message => message.role === "user").length;
      const latestInput = (current.workbenchMessages ?? []).filter(message => message.role === "user").at(-1)?.text || "";
      try {
        const releaseTarget = parseWorkbenchReleaseTarget(latestInput);
        if (deps.route && !releaseTarget && !isWorkbenchCancellation(latestInput) && !isWorkbenchResetRequest(latestInput)) {
          deps.update(id, { status: "planning", message: "正在理解你的消息…" });
          deps.event(id, "session_turn", "正在理解你的消息…");
          const reply = await deps.route(current);
          if (deps.get(id)?.workbenchPauseRequested) return;
          if (reply !== undefined) {
            deps.update(id, { status: current.status, message: current.message, workbenchProcessedInputs: inputCount, ...(reply.needsInput ? {
              workbenchNeedsInput: true, workbenchQuestion: reply.message, workbenchInputSource: "analysis" as const, message: "等待你的回复",
            } : {}) });
            appendAssistant(id, reply.message);
            continue;
          }
          // New steering arrived during routing: never analyze the obsolete request.
          if ((deps.get(id)?.workbenchMessages ?? []).filter(message => message.role === "user").length > inputCount) {
            deps.update(id, { status: current.status, message: current.message });
            continue;
          }
        }
        deps.update(id, workbenchTransitions.beginAnalysis(current));
        deps.event(id, "session_turn", "正在读取需求、对话和项目代码");
        if (releaseTarget) {
          // Branch operations must never become an agent implementation plan.
          deps.update(id, { status: current.status, workbenchProcessedInputs: inputCount });
          try {
            const message = deps.release ? await deps.release(id, releaseTarget) : "请使用任务的发版分支合并功能处理指定分支。";
            deps.update(id, { message });
            appendAssistant(id, message);
          } catch (error) {
            const message = `发版合并未完成：${error instanceof Error ? error.message : String(error)}。任务代码已保留，请查看合并记录后重试。`;
            deps.update(id, { status: current.status, message });
            appendAssistant(id, message);
          }
          continue;
        }
        if ((isWorkbenchCancellation(latestInput) || isWorkbenchResetRequest(latestInput)) && deps.cancel) {
          const reply = await deps.cancel(id, isWorkbenchResetRequest(latestInput));
          deps.update(id, { workbenchProcessedInputs: inputCount });
          appendAssistant(id, reply);
          continue;
        }
        if (current.taskMode === "test-case") {
          deps.update(id, { workbenchProcessedInputs: inputCount, workbenchLatestPrompt: buildWorkbenchRequest(current) });
          await deps.testCases(id);
          if (deps.get(id)?.workbenchPauseRequested) return;
          const latest = deps.get(id)!;
          if (latest.status !== "failed") appendAssistant(id, latest.message || "测试用例已生成，可以查看或下载。");
        } else {
          const decision = await deps.analyze(deps.get(id)!);
          if (deps.get(id)?.workbenchPauseRequested) return;
          deps.update(id, { workbenchProcessedInputs: inputCount });
          if (decision.action !== "cancel") appendAssistant(id, decision.message);
          // New steering arrived while analyzing: do not execute an obsolete plan.
          if (pending(deps.get(id)!)) continue;
          if (decision.action === "cancel" && deps.cancel) {
            appendAssistant(id, await deps.cancel(id, isWorkbenchResetRequest(latestInput)));
          } else if (decision.action === "test_cases") {
            const originalMode = current.taskMode;
            deps.update(id, workbenchTransitions.beginTestCases(deps.get(id)!));
            try {
              await deps.testCases(id);
            } finally {
              deps.update(id, { taskMode: originalMode });
            }
            const latest = deps.get(id)!;
            if (latest.workbenchPauseRequested) return;
            if (latest.status !== "failed") {
              const patch = workbenchTransitions.finishTestCases(latest);
              deps.update(id, patch);
              appendAssistant(id, patch.message!);
            }
          } else if (decision.action === "implement" && current.taskMode !== "question" && !current.workbenchAnalysisOnly) {
            deps.update(id, workbenchTransitions.beginImplementation(deps.get(id)!, decision.plan));
            await deps.execute(id);
            const latest = deps.get(id)!;
            if (latest.workbenchPauseRequested) return;
            if (latest.implementationSummary) appendAssistant(id, latest.implementationSummary);
          } else {
            const latest = deps.get(id)!;
            deps.update(id, workbenchTransitions.reply(latest, decision));
          }
        }
      } catch (error) {
        const latest = deps.get(id);
        if (latest?.workbenchPauseRequested) return;
        const text = error instanceof Error ? error.message : String(error);
        deps.update(id, workbenchTransitions.interrupt(text, inputCount));
        deps.event(id, "session_error", text);
      }
      if (!deps.get(id) || !pending(deps.get(id)!)) return;
    }
  };
  const start = (id: string): Promise<void> => {
    const existing = running.get(id);
    if (existing) return existing;
    deps.update(id, { workbenchTurnRunning: true });
    const task = Promise.resolve().then(() => drive(id)).finally(() => {
      running.delete(id);
      deps.update(id, { workbenchTurnRunning: false });
      if (resumeAfterPause.delete(id)) deps.update(id, { workbenchPauseRequested: false });
      const latest = deps.get(id);
      if (latest && !latest.workbenchPauseRequested && pending(latest)) void start(id);
    });
    running.set(id, task);
    return task;
  };
  return { start, isRunning: (id: string) => running.has(id), resumeAfterPause: (id: string) => { resumeAfterPause.add(id); } };
}

