import { execSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "../.env");

function getPort() {
  if (!existsSync(envPath)) return 6080;
  const match = readFileSync(envPath, "utf8").match(/^PORT=(\d+)/m);
  return match ? Number(match[1]) : 6080;
}

function killPortWindows(port) {
  const output = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, {
    encoding: "utf8",
  });

  const pids = [
    ...new Set(
      output
        .trim()
        .split("\n")
        .map((line) => line.trim().split(/\s+/).pop())
        .filter((pid) => pid && pid !== "0")
    ),
  ];

  for (const pid of pids) {
    execSync(`taskkill /F /PID ${pid} /T`, { stdio: "inherit" });
    console.log(`已结束进程树 PID ${pid}`);
  }

  return pids.length;
}

function killPortUnix(port) {
  let pids = [];

  try {
    const output = execSync(`lsof -ti :${port} -sTCP:LISTEN`, { encoding: "utf8" });
    pids = output.trim().split("\n").filter(Boolean);
  } catch {
    try {
      const output = execSync(`fuser -n tcp ${port} 2>/dev/null`, { encoding: "utf8" });
      pids = output.trim().split(/\s+/).filter(Boolean);
    } catch {
      return 0;
    }
  }

  for (const pid of pids) {
    try {
      process.kill(Number(pid), "SIGTERM");
      console.log(`已结束进程 PID ${pid}`);
    } catch {
      execSync(`kill -9 ${pid}`);
      console.log(`已强制结束进程 PID ${pid}`);
    }
  }

  return pids.length;
}

const port = getPort();

try {
  const count = process.platform === "win32" ? killPortWindows(port) : killPortUnix(port);

  if (count === 0) {
    console.log(`端口 ${port} 未被占用`);
  }
} catch {
  console.log(`端口 ${port} 未被占用`);
}
