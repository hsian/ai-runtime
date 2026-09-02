import express from "express";
import { existsSync } from "node:fs";
import { join } from "node:path";

import cors from "cors";

import { config } from "./config.js";

import { jobsRouter } from "./routes/jobs.js";

import { tapdRouter } from "./routes/tapd.js";

import { initJobStore } from "./services/jobStore.js";
import { closeDatabase } from "./services/database.js";
import { initHousekeeping } from "./services/housekeeping.js";
import { clientIdentityMiddleware, getClientIdentity } from "./services/clientIdentity.js";
import { operationLogsRouter } from "./routes/operationLogs.js";
import { projectsRouter } from "./routes/projects.js";
import { resetAllProjectWorkspaces } from "./services/projectRuntime.js";



initJobStore();
initHousekeeping();



void resetAllProjectWorkspaces();



const app = express();
app.set("trust proxy", false);



app.use(

  cors({

    origin: config.CORS_ORIGIN === "*" ? true : config.CORS_ORIGIN.split(","),

    methods: ["GET", "POST", "OPTIONS"],

    allowedHeaders: ["Content-Type"],
    credentials: true,

  })

);

app.use(express.json({ limit: "1mb" }));
app.use(clientIdentityMiddleware);



app.get("/health", (_req, res) => {

  res.json({ status: "ok", timestamp: new Date().toISOString() });

});

app.get("/api/client", (req, res) => {
  const identity = getClientIdentity(req);
  res.json({ remoteIp: identity.remoteIp });
});



app.use("/api/jobs", jobsRouter);
app.use("/api/projects", projectsRouter);

app.use("/api/tapd", tapdRouter);
app.use("/api/operation-logs", operationLogsRouter);

if (existsSync(config.WEB_DIST_DIR)) {
  app.use(express.static(config.WEB_DIST_DIR));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/")) {
      next();
      return;
    }
    res.sendFile(join(config.WEB_DIST_DIR, "index.html"));
  });
} else {
  console.warn(`[AI Runtime] 未找到 Web 构建目录: ${config.WEB_DIST_DIR}`);
}



const server = app.listen(config.PORT, "0.0.0.0", () => {

  console.log(`[AI Runtime] 服务已启动: http://0.0.0.0:${config.PORT}`);

  console.log(
    `[AI Runtime] Agent: ${config.AGENT_PROVIDER === "codex" ? "Codex CLI" : "Claude Code CLI"} (${
      config.AGENT_PROVIDER === "codex" ? config.CODEX_CLI_PATH : config.CLAUDE_CLI_PATH
    })`
  );

  console.log(`[AI Runtime] 健康检查: http://localhost:${config.PORT}/health`);

  if (config.PORT === 6000) {

    console.warn("[AI Runtime] 警告: 端口 6000 被 Chrome 禁止访问，插件会报 Failed to fetch，建议改用 6080 或 8080");

  }

});



function shutdown(signal: string): void {

  console.log(`\n[AI Runtime] 收到 ${signal}，正在关闭服务...`);

  server.close(() => {

    console.log("[AI Runtime] 服务已关闭");

    closeDatabase();

    process.exit(0);

  });

  setTimeout(() => process.exit(1), 3000).unref();

}



process.on("SIGINT", () => shutdown("SIGINT"));

process.on("SIGTERM", () => shutdown("SIGTERM"));

