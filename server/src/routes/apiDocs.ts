import { Router } from "express";
import { z } from "zod";
import { requireSameOrigin } from "../services/auth.js";
import { getClientIdentity } from "../services/clientIdentity.js";
import { getApiDocDetail, searchApiDocs } from "../services/apiDocs.js";
import { executeApiDocRequest } from "../services/apiDocDebug.js";
import { formatApiDocMarkdown } from "../services/apiDocExport.js";

export const apiDocsRouter = Router();
const debugAttempts = new Map<string, { count: number; expiresAt: number }>();
const debugRequestSchema = z.object({
  service: z.string().min(1).max(100),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]),
  path: z.string().startsWith("/").max(500),
  url: z.string().url().max(2048),
  headers: z.record(z.string().max(8192)).refine((value) => Object.keys(value).length <= 40),
  body: z.string().max(1024 * 1024).optional(),
});

apiDocsRouter.get("/search", async (req, res) => {
  const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (query.length > 200) { res.status(400).json({ error: "查询内容过长" }); return; }
  try { res.json(await searchApiDocs(query)); }
  catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : "接口文档索引失败" }); }
});

apiDocsRouter.get("/detail", async (req, res) => {
  const service = typeof req.query.service === "string" ? req.query.service : "";
  const method = typeof req.query.method === "string" ? req.query.method : "";
  const path = typeof req.query.path === "string" ? req.query.path : "";
  if (!service || !/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/i.test(method) || !path.startsWith("/") || path.length > 500) {
    res.status(400).json({ error: "接口参数无效" }); return;
  }
  try {
    const detail = await getApiDocDetail(service, method, path);
    if (!detail) { res.status(404).json({ error: "未找到该接口定义，请刷新索引后重试" }); return; }
    res.json(detail);
  } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : "读取接口定义失败" }); }
});

apiDocsRouter.get("/export", async (req, res) => {
  const service = typeof req.query.service === "string" ? req.query.service : "";
  const method = typeof req.query.method === "string" ? req.query.method : "";
  const path = typeof req.query.path === "string" ? req.query.path : "";
  if (!service || service.length > 100 || !/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/i.test(method) || !path.startsWith("/") || path.length > 500) {
    res.status(400).json({ error: "接口参数无效" }); return;
  }
  try {
    const detail = await getApiDocDetail(service, method, path);
    if (!detail) { res.status(404).json({ error: "未找到该接口定义，请刷新索引后重试" }); return; }
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.send(formatApiDocMarkdown(detail));
  } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : "导出接口文档失败" }); }
});

apiDocsRouter.post("/execute", requireSameOrigin, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const parsed = debugRequestSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "调试请求格式无效，检查地址、请求头和请求体大小" }); return; }
  const ownerId = getClientIdentity(req).ownerId;
  const now = Date.now();
  const previous = debugAttempts.get(ownerId);
  if (debugAttempts.size > 1000) {
    for (const [id, value] of debugAttempts) if (value.expiresAt <= now) debugAttempts.delete(id);
  }
  const attempt = previous && previous.expiresAt > now ? previous : { count: 0, expiresAt: now + 60_000 };
  if (attempt.count >= 30) { res.status(429).json({ error: "调试请求过于频繁，请一分钟后重试" }); return; }
  attempt.count += 1;
  debugAttempts.set(ownerId, attempt);
  try { res.json(await executeApiDocRequest(parsed.data)); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "调试请求失败" }); }
});
