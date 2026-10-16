import { config } from "../../config.js";
import type { Job } from "../../types.js";
import { getTaskState } from "@ai-runtime/shared/task-state";

export function formatModelCommand(jobs: Job[]): string {
  const model = (provider: "codex" | "claude", job?: Job) => {
    const configured = provider === "codex" ? config.CODEX_MODEL
      : job?.taskMode === "test-case" ? config.CLAUDE_TEST_CASE_MODEL : config.CLAUDE_MODEL;
    return configured?.trim() || "CLI 默认（未指定具体型号）";
  };
  const lines = [`默认引擎：Codex`, `默认模型：${model("codex")}`];
  const busy = jobs.filter(job => getTaskState(job).busy);
  const selected = busy.length ? busy : [...jobs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 1);
  if (!selected.length) lines.push("当前没有任务执行记录。");
  for (const job of selected) {
    const provider = job.agentProvider;
    lines.push(`\n${busy.length ? "当前任务" : "最近任务"}：${job.tapdContext?.title || job.prompt.split("\n")[0].slice(0, 80)}`,
      `引擎：${provider === "claude" ? "Claude" : provider === "codex" ? "Codex" : "未记录"}`,
      `模型：${provider ? model(provider, job) : "未记录"}`);
  }
  lines.push("\n每次调用优先 Codex，额度耗尽时自动切换 Claude。型号显示配置值；CLI 未上报的实际型号不会猜测。");
  return lines.join("\n");
}
