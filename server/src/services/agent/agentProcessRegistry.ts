import { spawn, type ChildProcess } from "child_process";

const activeProcesses = new Map<string, ChildProcess>();

const IS_WINDOWS = process.platform === "win32";

function killChildProcess(child: ChildProcess): void {
  if (!child.pid) return;

  if (IS_WINDOWS) {
    try {
      spawn("taskkill", ["/F", "/PID", String(child.pid), "/T"], { shell: true, windowsHide: true });
    } catch {
      child.kill("SIGTERM");
    }
    return;
  }

  child.kill("SIGTERM");
}

export function registerAgentProcess(jobId: string, child: ChildProcess): void {
  activeProcesses.set(jobId, child);
}

export function unregisterAgentProcess(jobId: string): void {
  activeProcesses.delete(jobId);
}

export function killAgentForJob(jobId: string): boolean {
  const child = activeProcesses.get(jobId);
  if (!child) return false;
  activeProcesses.delete(jobId);
  killChildProcess(child);
  return true;
}
