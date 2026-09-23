import { Router } from "express";
import { z } from "zod";

import { getTapdConfig } from "../config.js";
import { getAuthUser, requirePermission } from "../services/auth.js";
import { getDatabase } from "../services/database.js";
import { logOperation } from "../services/operationLog.js";
import { allocateHours, listWorkTasks, updateWorkTask } from "../services/tapd/workHours.js";

export const workHoursRouter = Router();
workHoursRouter.use(requirePermission("work_hours.view"));

const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const selectionSchema = z.object({
  month: monthSchema,
  workspaceIds: z.array(z.string()).min(1).max(30),
});

workHoursRouter.get("/projects", (_req, res) => {
  try { res.json({ projects: getTapdConfig().workspaces }); }
  catch (error) { res.status(503).json({ error: error instanceof Error ? error.message : "TAPD 未配置" }); }
});

workHoursRouter.post("/preview", async (req, res) => {
  const input = selectionSchema.extend({ targetHours: z.number().int().min(1).max(744) }).safeParse(req.body);
  if (!input.success) { res.status(400).json({ error: "月份、项目或目标工时无效" }); return; }
  try {
    const tasks = await listWorkTasks(input.data.month, getAuthUser(req)!.tapdOwnerName, input.data.workspaceIds);
    const allocation = allocateHours(tasks, input.data.targetHours);
    res.json({ tasks, proposals: allocation.map(({ task, hours, pages, score }) => ({ id: task.id, workspaceId: task.workspaceId, hours, pages, score })) });
  } catch (error) { res.status(502).json({ error: error instanceof Error ? error.message : "TAPD 任务读取失败" }); }
});

workHoursRouter.post("/apply", requirePermission("work_hours.apply"), async (req, res) => {
  const input = selectionSchema.extend({ entries: z.array(z.object({
    id: z.string().regex(/^\d+$/), workspaceId: z.string(),
    hours: z.number().int().min(1).max(16), pages: z.number().int().min(0).max(100),
    expectedHours: z.string(), expectedPages: z.string(),
  })).min(1).max(500) }).safeParse(req.body);
  if (!input.success) { res.status(400).json({ error: "写入内容无效" }); return; }
  const user = getAuthUser(req)!;
  const keys = input.data.entries.map((entry) => `${entry.workspaceId}:${entry.id}`);
  if (new Set(keys).size !== keys.length || input.data.entries.some((entry) => !input.data.workspaceIds.includes(entry.workspaceId))) {
    res.status(400).json({ error: "任务列表存在重复或未选项目" }); return;
  }
  try {
    const tasks = await listWorkTasks(input.data.month, user.tapdOwnerName, input.data.workspaceIds);
    const taskMap = new Map(tasks.map((task) => [`${task.workspaceId}:${task.id}`, task]));
    const results: Array<{ id: string; workspaceId: string; ok: boolean; error?: string }> = [];
    for (const entry of input.data.entries) {
      const task = taskMap.get(`${entry.workspaceId}:${entry.id}`);
      if (!task || task.currentHours !== entry.expectedHours || task.currentPages !== entry.expectedPages) {
        results.push({ id: entry.id, workspaceId: entry.workspaceId, ok: false, error: "任务已变化，请重新生成预览" });
        continue;
      }
      if (task.currentHours || task.currentPages) {
        results.push({ id: entry.id, workspaceId: entry.workspaceId, ok: false, error: "已有填报值，不自动覆盖" });
        continue;
      }
      try {
        await updateWorkTask(task, entry.hours, entry.pages, user.tapdOwnerName);
        getDatabase().prepare(`INSERT INTO work_hour_changes
          (user_id, workspace_id, task_id, old_hours, new_hours, old_pages, new_pages, changed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(user.id, task.workspaceId, task.id, task.currentHours,
          String(entry.hours), task.currentPages, String(entry.pages), new Date().toISOString());
        logOperation({ action: "tapd_work_hours_apply", status: "success", ownerId: user.id, workspaceId: task.workspaceId, tapdItemId: task.id, message: `${entry.hours}h, ${entry.pages} pages` });
        results.push({ id: entry.id, workspaceId: entry.workspaceId, ok: true });
      } catch (error) {
        results.push({ id: entry.id, workspaceId: entry.workspaceId, ok: false, error: error instanceof Error ? error.message : "写入失败" });
      }
    }
    res.json({ results });
  } catch (error) { res.status(502).json({ error: error instanceof Error ? error.message : "TAPD 任务读取失败" }); }
});
