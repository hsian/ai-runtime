import express from "express";
import cors from "cors";
import { config } from "./config.js";
import { jobsRouter } from "./routes/jobs.js";

const app = express();

app.use(
  cors({
    origin: config.CORS_ORIGIN === "*" ? true : config.CORS_ORIGIN.split(","),
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.use("/api/jobs", jobsRouter);

const server = app.listen(config.PORT, "0.0.0.0", () => {
  console.log(`[AI Runtime] 服务已启动: http://0.0.0.0:${config.PORT}`);
  console.log(`[AI Runtime] Agent: Claude Code CLI (${config.CLAUDE_CLI_PATH})`);
  console.log(`[AI Runtime] 健康检查: http://localhost:${config.PORT}/health`);
  if (config.PORT === 6000) {
    console.warn("[AI Runtime] 警告: 端口 6000 被 Chrome 禁止访问，插件会报 Failed to fetch，建议改用 6080 或 8080");
  }
});

function shutdown(signal: string): void {
  console.log(`\n[AI Runtime] 收到 ${signal}，正在关闭服务...`);
  server.close(() => {
    console.log("[AI Runtime] 服务已关闭");
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 3000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
