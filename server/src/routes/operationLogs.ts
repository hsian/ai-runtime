import { Router } from "express";

import { getClientIdentity } from "../services/clientIdentity.js";
import { listOperationLogDates, readOperationLogs } from "../services/operationLog.js";

export const operationLogsRouter = Router();

operationLogsRouter.get("/dates", async (_req, res) => {
  try {
    res.json({ dates: await listOperationLogDates() });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "日志日期读取失败" });
  }
});

operationLogsRouter.get("/", async (req, res) => {
  const date = typeof req.query.date === "string" ? req.query.date : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: "日志日期格式无效" });
    return;
  }
  const limit = typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : undefined;
  try {
    const identity = getClientIdentity(req);
    const entries = await readOperationLogs({ date, ownerId: identity.ownerId, limit });
    res.json({ entries });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "操作日志读取失败" });
  }
});
