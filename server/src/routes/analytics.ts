import { Router } from "express";

import { getAnalytics, getCodeChangeAnalytics } from "../services/analyticsService.js";
import { listProjects } from "../services/projectRegistry.js";

export const analyticsRouter = Router();

function readFilters(req: import("express").Request, res: import("express").Response): { days: number; projectId?: string } | undefined {
  const parsedDays = typeof req.query.days === "string" ? Number.parseInt(req.query.days, 10) : 30;
  const days = [7, 30, 90].includes(parsedDays) ? parsedDays : 30;
  const projectId = typeof req.query.projectId === "string" && req.query.projectId ? req.query.projectId : undefined;
  if (projectId && !listProjects().some((project) => project.id === projectId)) {
    res.status(400).json({ error: "项目不存在" });
    return undefined;
  }
  return { days, projectId };
}

analyticsRouter.get("/", (req, res) => {
  const filters = readFilters(req, res);
  if (!filters) return;
  try {
    res.setHeader("Cache-Control", "private, no-store");
    res.json(getAnalytics(filters.days, filters.projectId));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "统计数据读取失败" });
  }
});

analyticsRouter.get("/code-changes", async (req, res) => {
  const filters = readFilters(req, res);
  if (!filters) return;
  try {
    res.setHeader("Cache-Control", "private, no-store");
    res.json(await getCodeChangeAnalytics(filters.days, filters.projectId));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "代码改动统计失败" });
  }
});
