import { getTapdConfig, type TapdConfig } from "../../config.js";
import { getJob, updateJob } from "../jobStore.js";
import { appendJobEvent } from "../jobEvents.js";
import { getBug, getTask, tapdPost, tapdRequest } from "./tapdClient.js";

/** Resolve the project's actual workflow status and hand the defect back to its reporter. */
export async function resolveBug(target: { workspaceId: string; bugId: string }, operator: string, cfg: TapdConfig = getTapdConfig()): Promise<void> {
  const before = await getBug(target.bugId, target.workspaceId, cfg);
  if (!before) throw new Error("TAPD Bug 已不存在，请核对缺陷记录");
  const fields = await tapdRequest<{ status?: { options?: Record<string, string> } }>(cfg, "/bugs/get_fields_info", { workspace_id: target.workspaceId });
  const statuses = fields.data?.status?.options || {};
  const resolved = Object.entries(statuses).filter(([, label]) => label === "已解决");
  if (resolved.length !== 1) throw new Error("项目没有唯一的‘已解决’状态，请核对 TAPD 缺陷流程");
  const resolvedStatus = resolved[0][0];
  const reporter = before.reporter?.trim();
  if (!reporter || reporter.includes(";")) throw new Error("无法确定 Bug 创建人，请在 TAPD 补全创建人后重试同步");
  const owners = (before.current_owner || before.owner || "").split(";").map(value => value.trim()).filter(Boolean);
  if (before.status === resolvedStatus && owners.length === 1 && owners[0] === reporter) return;
  if (["closed", "verified"].includes(before.status || "") || ["已关闭", "已验证"].includes(statuses[before.status || ""])) throw new Error("Bug 已进入回归后的状态，不会回退为已解决，请核对 TAPD");
  if (!operator || !owners.includes(operator)) throw new Error("Bug 当前处理人已变化，请确认 TAPD 分配后重试同步");
  await tapdPost(cfg, "/bugs", { workspace_id: target.workspaceId, id: target.bugId, current_user: operator, status: resolvedStatus, current_owner: `${reporter};` });
  const after = await getBug(target.bugId, target.workspaceId, cfg);
  const afterOwners = (after?.current_owner || after?.owner || "").split(";").map(value => value.trim()).filter(Boolean);
  if (after?.status !== resolvedStatus || after.reporter?.trim() !== reporter || afterOwners.length !== 1 || afterOwners[0] !== reporter) throw new Error("Bug 状态或处理人同步未生效，请核对后重试同步");
}

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
export function syncWorkbenchTask(jobId: string, target: "open" | "progressing" | "done" | "resolved"): Promise<void> {
  const active = syncing.get(jobId);
  if (active) return active;
  const job = getJob(jobId);
  const bug = job?.tapdContext?.itemType === "bug" && job.tapdContext.itemId ? { workspaceId: job.tapdContext.workspaceId, bugId: job.tapdContext.itemId } : undefined;
  if (!job?.workbenchSession || (!job.tapdTask && !bug) || job.taskMode !== "code") return Promise.resolve();
  if (bug) {
    if (target !== "done" && target !== "resolved") return Promise.resolve();
    target = "resolved";
  } else if (target === "resolved") return Promise.reject(new Error("当前记录不是 TAPD Bug"));
  if ((target === "done" || target === "resolved") && !job.mergedToDefaultAt) return Promise.reject(new Error("代码尚未合并，不能完成 TAPD 同步"));
  if (job.tapdSync?.target === target && job.tapdSync.state === "synced") return Promise.resolve();
  updateJob(jobId, { tapdSync: { target, state: "pending" } });
  const operation = (async () => {
    try {
      if (bug) {
        await resolveBug(bug, job.tapdOperator || "");
        updateJob(jobId, { tapdSync: { target: "resolved", state: "synced" } });
        appendJobEvent(jobId, { type: "stage", phase: "tapd_sync", text: "TAPD Bug 已解决，处理人已转回创建人，请测试回归。" });
        return;
      }
      if (target === "progressing" && !job.tapdOriginalTaskStatus) {
        const before = await getTask(job.tapdTask!.taskId, job.tapdTask!.workspaceId);
        updateJob(jobId, { tapdOriginalTaskStatus: before?.status });
      }
      const actual = await writeTaskStatus(job.tapdTask!, job.tapdOperator || "", target as "open" | "progressing" | "done");
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
