import assert from "node:assert/strict";
import { test } from "node:test";
import type { Job } from "../../types.js";

Object.assign(process.env, { GIT_ACCESS_TOKEN: "test-only", CODEX_MODEL: "codex-configured", CLAUDE_MODEL: "claude-configured", CLAUDE_TEST_CASE_MODEL: "cases-configured" });
const { formatModelCommand } = await import("./modelCommand.js");
const { config } = await import("../../config.js");
const job = (patch: Partial<Job>): Job => ({ jobId: "test", ownerId: "test", projectId: "b2b-composite", prompt: "test", status: "completed", createdAt: "2026-10-16T00:00:00Z", updatedAt: "2026-10-16T00:00:00Z", ...patch });

test("model query distinguishes configured Codex, Claude and test-case models", () => {
  assert.match(formatModelCommand([]), /默认模型：codex-configured/);
  assert.match(formatModelCommand([job({ agentProvider: "claude" })]), /引擎：Claude\n模型：claude-configured/);
  assert.match(formatModelCommand([job({ agentProvider: "claude", taskMode: "test-case" })]), /模型：cases-configured/);
  assert.match(formatModelCommand([job({ agentProvider: undefined })]), /引擎：未记录\n模型：未记录/);
});

test("missing model configuration is reported as CLI default rather than an invented model", () => {
  const previous = config.CODEX_MODEL;
  try {
    config.CODEX_MODEL = undefined;
    assert.match(formatModelCommand([]), /默认模型：CLI 默认（未指定具体型号）/);
  } finally { config.CODEX_MODEL = previous; }
});

test("active jobs take priority over recent idle jobs; otherwise report the latest actual job", () => {
  const older = job({ prompt: "active", status: "running", agentProvider: "claude" });
  const newer = job({ prompt: "idle", updatedAt: "2026-10-16T01:00:00Z", agentProvider: "codex" });
  const active = formatModelCommand([newer, older]);
  assert.match(active, /当前任务：active/); assert.doesNotMatch(active, /最近任务：idle/);
  assert.match(formatModelCommand([older, newer].map(item => ({ ...item, status: "completed" }))), /最近任务：idle/);
});
