import { getTapdConfig, type TapdConfig } from "../../config.js";
import { getJob, updateJob } from "../jobStore.js";
import { appendJobEvent } from "../jobEvents.js";
import { getTask, tapdPost } from "./tapdClient.js";

/** Update only the assigned task, never its parent requirement. Read back before accepting success. */
export async function writeTaskStatus(target: { workspaceId: string; taskId: string }, operator: string, status: "open" | "progressing" | "done", cfg: TapdConfig = getTapdConfig()): Promise<"open" | "progressing" | "done"> {
  const before = await getTask(target.taskId, target.workspaceId, cfg);
  if (!operator || !before?.owner?.split(";").map(value => value.trim()).includes(operator)) throw new Error("任务当前负责人已变化，请确认 TAPD 分配后重试");
  if (before.status === status || (status !== "done" && before.status === "done")) return before.status;
  await tapdPost(cfg, "/tasks", { workspace_id: target.workspaceId, id: target.taskId, current_user: operator, status });
  const after = await getTask(target.taskId, target.workspaceId, cfg);
  if (after?.status !== status) throw new Error("TAPD 状态写入未生效，请重试同步");
  return status;
}

const syncing = new Map<string, Promise<void>>();
export function syncWorkbenchTask(jobId: string, target: "open" | "progressing" | "done"): Promise<void> {
  const active = syncing.get(jobId);
  if (active) return active;
  const job = getJob(jobId);
  if (!job?.workbenchSession || !job.tapdTask || job.taskMode !== "code") return Promise.resolve();
  if (target === "done" && !job.mergedToDefaultAt) return Promise.reject(new Error("代码尚未合并，不能完成 TAPD 任务"));
  if (job.tapdSync?.target === target && job.tapdSync.state === "synced") return Promise.resolve();
  updateJob(jobId, { tapdSync: { target, state: "pending" } });
  const operation = (async () => {
    try {
      if (target === "progressing" && !job.tapdOriginalTaskStatus) {
        const before = await getTask(job.tapdTask!.taskId, job.tapdTask!.workspaceId);
        updateJob(jobId, { tapdOriginalTaskStatus: before?.status });
      }
      const actual = await writeTaskStatus(job.tapdTask!, job.tapdOperator || "", target);
      updateJob(jobId, { tapdSync: { target: actual, state: "synced" } });
      appendJobEvent(jobId, { type: "stage", phase: "tapd_sync", text: `TAPD 任务状态：${actual === "done" ? "已完成" : actual === "open" ? "未开始" : "进行中"}` });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      updateJob(jobId, { tapdSync: { target, state: "failed", error: text } });
      appendJobEvent(jobId, { type: "stage", phase: "tapd_sync_failed", text: `TAPD 状态待同步：${text}` });
    }
  })().finally(() => syncing.delete(jobId));
  syncing.set(jobId, operation);
  return operation;
}
