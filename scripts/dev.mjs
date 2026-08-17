import { spawn } from "node:child_process";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const tasks = [
  ["Server", ["run", "dev:server"]],
  ["Web", ["run", "dev:web"]],
];

let stopping = false;
let exitCode = 0;

const children = tasks.map(([name, args]) => {
  const child = spawn(npmCommand, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  child.on("error", (error) => {
    console.error(`[dev] ${name} 启动失败:`, error.message);
    exitCode = 1;
    stop();
  });

  child.on("exit", (code, signal) => {
    if (!stopping) {
      console.error(`[dev] ${name} 已退出 (${signal || code || 0})，正在关闭其他服务。`);
      exitCode = code || 1;
      stop();
    }
  });

  return child;
});

function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null && !child.killed) child.kill(signal);
  }
}

process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));
process.once("exit", () => stop());

await Promise.all(children.map((child) => new Promise((resolve) => child.once("close", resolve))));
process.exitCode = exitCode;
