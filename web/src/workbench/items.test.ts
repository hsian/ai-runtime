import assert from "node:assert/strict";
import test from "node:test";
import type { JobStatus } from "../types";
import { findWorkbenchJob, mergeWorkbenchItems } from "./items";
import { isOwner, type WorkItem } from "./model";

const item = (patch: Partial<WorkItem> = {}): WorkItem => ({
  id: "local", title: "已有对话", description: "", source: "manual", projectId: "repo",
  taskMode: "code", conversationId: "conversation", createdAt: "2026-10-15", ...patch,
});
const job = (patch: Partial<JobStatus> = {}): JobStatus => ({
  jobId: "job", projectId: "repo", conversationId: "conversation", taskMode: "code",
  workbenchSession: true, status: "awaiting_input", prompt: "服务端对话",
  createdAt: "2026-10-15", updatedAt: "2026-10-15", ...patch,
});

test("服务端历史补回本地未保存的对话，已有标题保留，TAPD 会话不进入自由对话", () => {
  const saved = [item()];
  const jobs = [job(), job({ jobId: "restored", conversationId: "restored", conversationTitle: "跨浏览器恢复的对话" }),
    job({ jobId: "tapd", conversationId: "tapd", tapdTask: { workspaceId: "100", taskId: "1" } })];
  const result = mergeWorkbenchItems(saved, [], jobs);
  assert.deepEqual(result.map(value => value.title), ["已有对话", "跨浏览器恢复的对话"]);
  assert.equal(result[1].conversationId, "restored");
  assert.deepEqual(saved, [item()]);
});

test("手动刷新得到的 TAPD 标题、状态和依赖覆盖旧快照，执行关联仍保留", () => {
  const saved = item({ id: "100:task:1", source: "tapd", title: "旧标题", tapdStatus: "open", workspaceId: "100", iterationId: "200" });
  const remote = item({ id: saved.id, source: "tapd", title: "最新标题", tapdStatus: "done", itemType: "task", projectId: "", conversationId: "", backendTasks: [{ id: "backend", name: "后端接口", status: "done" }] });
  const result = mergeWorkbenchItems([saved], [remote], []);
  assert.equal(result[0].title, "最新标题");
  assert.equal(result[0].tapdStatus, "done");
  assert.equal(result[0].conversationId, "conversation");
  assert.equal(result[0].projectId, "repo");
  assert.deepEqual(result[0].backendTasks, remote.backendTasks);
  assert.deepEqual(mergeWorkbenchItems([saved], [], []), [], "旧迭代的 TAPD 缓存不能残留到新列表");
});

test("任务与 Bug 关联按项目、TAPD 工作空间和类型匹配，并读取最新轮次", () => {
  const jobs = [job({ jobId: "wrong-project", projectId: "another", createdAt: "2026-10-18" }),
    job({ jobId: "latest", createdAt: "2026-10-17" }), job({ jobId: "older", createdAt: "2026-10-16" })];
  assert.equal(findWorkbenchJob(item(), jobs)?.jobId, "latest");
  const task = item({ source: "tapd", conversationId: "", itemType: "task", workspaceId: "100", tapdUrl: "https://tapd.invalid/task/1" });
  const linked = [job({ jobId: "wrong-space", tapdTask: { workspaceId: "101", taskId: "1" } }),
    job({ jobId: "task", tapdTask: { workspaceId: "100", taskId: "1" } })];
  assert.equal(findWorkbenchJob(task, linked)?.jobId, "task");
  const bug = { ...task, itemType: "bug" as const };
  assert.equal(findWorkbenchJob(bug, linked), undefined);
  assert.equal(findWorkbenchJob(item({ projectId: "missing" }), jobs), undefined);
});

test("处理人按完整姓名匹配，支持 TAPD 多处理人分隔符", () => {
  for (const value of ["张三", "李四;张三;", "李四，张三", "李四； 张三 |王五"]) assert.equal(isOwner(value, "张三"), true);
  for (const value of [undefined, "张三丰", "小张三", "李四"]) assert.equal(isOwner(value, "张三"), false);
  assert.equal(isOwner("张三", " "), false);
});
