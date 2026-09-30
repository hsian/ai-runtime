import { Router } from "express";
import { getApiDocDetail, searchApiDocs } from "../services/apiDocs.js";

export const apiDocsRouter = Router();

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
