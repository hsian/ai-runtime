import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentStreamEvent } from "./types.js";
import { commandActivity } from "./commandActivity.js";

process.env.GIT_ACCESS_TOKEN = "test-only";
const { handleCodexJsonLine } = await import("./codexAgentService.js");
const { latestAgentActivity } = await import("../../modules/wecom/replies.js");

test("Codex command events track separate starts, completion and failure without exposing raw commands", () => {
  const events: AgentStreamEvent[] = [];
  const state = { seenTools: new Set<string>(), lastStatusAt: 0, lastStatusText: "" };
  const send = (type: string, id: string, status: string, exit_code?: number) => handleCodexJsonLine(JSON.stringify({
    type, item: { id, type: "command_execution", command: "SECRET_TOKEN=private npm run test", status, exit_code },
  }), event => events.push(event), state);
  send("item.started", "test-1", "in_progress");
  send("item.completed", "test-1", "completed", 1);
  send("item.started", "test-2", "in_progress");
  send("item.completed", "test-2", "completed", 0);
  send("item.completed", "test-2", "completed", 0);
  assert.deepEqual(events.map(event => event.toolAction), ["start", "done", "start", "done"]);
  assert.doesNotMatch(JSON.stringify(events), /SECRET|private/);
  assert.equal(JSON.parse(events[1].toolDetail!).failed, true);
  const stage = { id: "stage", jobId: "job", timestamp: "now", type: "stage" as const, phase: "agent" };
  const jobEvents = events.map((event, i) => ({ ...stage, ...event, id: String(i) }));
  assert.match(latestAgentActivity([stage, ...jobEvents.slice(0, 2)]), /未通过：运行回归测试/);
  assert.match(latestAgentActivity([stage, ...jobEvents]), /已完成：运行回归测试.*已结束 2 项操作/);
});

test("command activities reveal only fixed categories and file changes emit a completed action", () => {
  assert.equal(commandActivity({ command: "npm ci" }), "安装项目依赖");
  assert.equal(commandActivity("pnpm run build"), "检查编译和代码规范");
  assert.equal(commandActivity("git diff --check"), "检查代码变更");
  assert.equal(commandActivity("rg SECRET file"), "查阅和定位代码");
  const events: AgentStreamEvent[] = [];
  handleCodexJsonLine(JSON.stringify({ type: "item.completed", item: { id: "edit", type: "file_change", status: "completed" } }),
    event => events.push(event), { seenTools: new Set<string>(), lastStatusAt: 0, lastStatusText: "" });
  assert.equal(events[0].toolAction, "done");
  assert.equal(JSON.parse(events[0].toolDetail!).activity, "修改代码文件");
});
