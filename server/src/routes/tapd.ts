import { Router } from "express";
import { getTapdConfig, isTapdConfigured } from "../config.js";
import {
  getIterationWorkItems,
  getStory,
  getTask,
  listIterationTasks,
  listIterations,
  parseTapdUrl,
} from "../services/tapd/tapdClient.js";
import {
  countImagesInHtml,
  downloadImagesFromHtml,
} from "../services/tapd/tapdDescriptionImages.js";

export const tapdRouter = Router();

function tapdNotConfigured(_req: import("express").Request, res: import("express").Response): boolean {
  if (isTapdConfigured()) return false;
  res.status(503).json({
    error: "TAPD 未配置，请在 server/.env 填写 TAPD_CLIENT_ID、TAPD_CLIENT_SECRET、TAPD_WORKSPACE_ID",
  });
  return true;
}

tapdRouter.get("/health", async (_req, res) => {
  if (tapdNotConfigured(_req, res)) return;
  try {
    const cfg = getTapdConfig();
    const iterations = await listIterations(cfg.workspaceId);
    res.json({
      ok: true,
      workspaceId: cfg.workspaceId,
      iterationCount: iterations.length,
    });
  } catch (err) {
    res.status(502).json({
      ok: false,
      error: err instanceof Error ? err.message : "TAPD 连接失败",
    });
  }
});

tapdRouter.get("/iterations", async (req, res) => {
  if (tapdNotConfigured(req, res)) return;
  try {
    const workspaceId =
      typeof req.query.workspaceId === "string" ? req.query.workspaceId : getTapdConfig().workspaceId;
    const iterations = await listIterations(workspaceId);
    res.json({ workspaceId, iterations });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "获取迭代列表失败" });
  }
});

tapdRouter.get("/iterations/:iterationId/tasks", async (req, res) => {
  if (tapdNotConfigured(req, res)) return;
  try {
    const workspaceId =
      typeof req.query.workspaceId === "string" ? req.query.workspaceId : getTapdConfig().workspaceId;
    const prefix = typeof req.query.prefix === "string" ? req.query.prefix : undefined;
    const tasks = await listIterationTasks(req.params.iterationId, { workspaceId, prefix });
    const enriched = tasks.map((task) => ({
      ...task,
      imageCount: countImagesInHtml(task.description ?? ""),
    }));
    res.json({ workspaceId, iterationId: req.params.iterationId, prefix: prefix ?? null, tasks: enriched });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "获取任务列表失败" });
  }
});

tapdRouter.get("/iterations/:iterationId/items", async (req, res) => {
  if (tapdNotConfigured(req, res)) return;
  try {
    const workspaceId =
      typeof req.query.workspaceId === "string" ? req.query.workspaceId : getTapdConfig().workspaceId;
    const items = await getIterationWorkItems(req.params.iterationId, workspaceId);
    res.json(items);
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "获取迭代工作项失败" });
  }
});

tapdRouter.post("/images/from-html", async (req, res) => {
  if (tapdNotConfigured(req, res)) return;
  const html = typeof req.body?.html === "string" ? req.body.html : "";
  const workspaceId =
    typeof req.body?.workspaceId === "string" ? req.body.workspaceId : getTapdConfig().workspaceId;
  if (!html.trim()) {
    res.status(400).json({ error: "缺少 html 正文" });
    return;
  }
  try {
    const report = await downloadImagesFromHtml(html, workspaceId);
    res.json({
      count: report.images.length,
      expected: report.expected,
      images: report.images,
      failedUrls: report.failedUrls,
      warning:
        report.expected > 0 && report.images.length === 0
          ? "描述中有配图但全部下载失败（已尝试 TAPD 官方图片 API）"
          : report.failedUrls.length > 0
            ? `仅成功 ${report.images.length}/${report.expected} 张配图`
            : undefined,
    });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "下载配图失败" });
  }
});

tapdRouter.get("/parse-url", (req, res) => {
  const url = typeof req.query.url === "string" ? req.query.url : "";
  if (!url) {
    res.status(400).json({ error: "缺少 url 参数" });
    return;
  }
  res.json(parseTapdUrl(url));
});

tapdRouter.get("/stories/:storyId", async (req, res) => {
  if (tapdNotConfigured(req, res)) return;
  try {
    const workspaceId =
      typeof req.query.workspaceId === "string" ? req.query.workspaceId : getTapdConfig().workspaceId;
    const story = await getStory(req.params.storyId, workspaceId);
    if (!story) {
      res.status(404).json({ error: "Story 不存在" });
      return;
    }
    res.json({ workspaceId, story });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "获取 Story 失败" });
  }
});

tapdRouter.get("/tasks/:taskId", async (req, res) => {
  if (tapdNotConfigured(req, res)) return;
  try {
    const workspaceId =
      typeof req.query.workspaceId === "string" ? req.query.workspaceId : getTapdConfig().workspaceId;
    const task = await getTask(req.params.taskId, workspaceId);
    if (!task) {
      res.status(404).json({ error: "Task 不存在" });
      return;
    }
    res.json({ workspaceId, task });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "获取 Task 失败" });
  }
});
