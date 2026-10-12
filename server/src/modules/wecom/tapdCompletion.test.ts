import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import type { TapdTask } from "../../services/tapd/tapdClient.js";

process.env.GIT_ACCESS_TOKEN = "test-only";
process.env.QWECHAT_BOT_ENABLED = "false";
const { TapdCompletionMonitor, notificationHours, currentMonthIteration } = await import("./tapdCompletion.js");
const { parseCompletionOptions } = await import("./config.js");

function setup() {
  const db = new Database(":memory:");
  const options = { workspaceIds: ["cc", "cq"], recipients: { "郑伟贤": "zheng", "袁力思": "yuan" } };
  let time = new Date("2026-10-12T09:00:00+08:00");
  let failing = false;
  let queryFailing = false;
  let authenticated = true;
  let blocked = false;
  const backend: TapdTask = { id: "backend", name: "后端-村财功能", status: "open", story_id: "story", iteration_id: "oct" };
  let changed = [backend];
  const fronts: TapdTask[] = [
    { id: "front1", name: "前端-功能", owner: "郑伟贤;袁力思;其他人;", story_id: "story", iteration_id: "oct" },
    { id: "front2", name: "前端-功能", owner: "郑伟贤;", story_id: "story", iteration_id: "oct" },
    { id: "test", name: "测试-功能", owner: "郑伟贤", story_id: "story", iteration_id: "oct" },
    { id: "other", name: "前端-功能", owner: "郑伟贤", story_id: "other-story", iteration_id: "oct" },
    { id: "old", name: "前端-功能", owner: "郑伟贤", story_id: "story", iteration_id: "sept" },
  ];
  const sent: { target: string; content: string }[] = [];
  const queries: { workspace?: string; iteration: string; modified?: string }[] = [];
  const workspaces: string[] = [];
  let storyQueries = 0;
  const deps = { db, cfg: { apiBase: "https://api.tapd.cn", clientId: "test", clientSecret: "test", workspaceId: "cc",
    workspaces: [{ id: "cc", name: "村财" }, { id: "cq", name: "产权" }] }, now: () => time,
    canSend: (target?: string) => authenticated && (!target || !blocked),
    async send(target: string, content: string) { if (failing) throw new Error("send failed"); sent.push({ target, content }); },
    async iterations(workspace?: string) { workspaces.push(workspace!); return [
      { id: "oct", name: "【研发】2026年10月" }, { id: "nov", name: "2026年11月13日" }, { id: "sept", name: "2026年9月30日" }]; },
    async tasks(iteration: string, query?: { workspaceId?: string; modified?: string }) {
      queries.push({ workspace: query?.workspaceId, iteration, modified: query?.modified });
      if (queryFailing) throw new Error("query failed");
      return query?.workspaceId === "cc" ? changed.map(task => ({ ...task })) : [];
    },
    async storyTasks() { storyQueries++; if (queryFailing) throw new Error("story query failed"); return fronts; },
  };
  let monitor = new TapdCompletionMonitor("bot", options, deps);
  return { db, backend, fronts, sent, queries, workspaces, options,
    tick: () => monitor.tick(), time(value: string) { time = new Date(value); },
    failSend(value: boolean) { failing = value; }, failQuery(value: boolean) { queryFailing = value; },
    auth(value: boolean) { authenticated = value; }, block(value: boolean) { blocked = value; },
    changed(value: TapdTask[]) { changed = value; },
    restart() { monitor.stop(); monitor = new TapdCompletionMonitor("bot", options, deps); },
    storyQueries: () => storyQueries,
    close() { monitor.stop(); db.close(); },
  };
}

test("Shanghai schedule and iteration names include date/research names but exclude other months", () => {
  assert.equal(notificationHours(new Date("2026-10-12T08:59:59+08:00")), false);
  assert.equal(notificationHours(new Date("2026-10-12T09:00:00+08:00")), true);
  assert.equal(notificationHours(new Date("2026-10-12T19:00:00+08:00")), true);
  assert.equal(notificationHours(new Date("2026-10-12T19:01:00+08:00")), false);
  const date = new Date("2026-10-01T00:00:00+08:00");
  for (const name of ["2026年10月14日", "【研发】2026年10 月", "2026年10月30日"]) assert.equal(currentMonthIteration(name, date), true);
  for (const name of ["2025年10月", "2026年11月", "2026年1月", "未命名"]) assert.equal(currentMonthIteration(name, date), false);
});

test("config validates explicit workspace IDs and name-to-user mapping", () => {
  assert.deepEqual(parseCompletionOptions("34579999,61733891", '{"郑伟贤":"zheng"}'),
    { workspaceIds: ["34579999", "61733891"], recipients: { "郑伟贤": "zheng" } });
  assert.throws(() => parseCompletionOptions("", '{}'));
  assert.throws(() => parseCompletionOptions("123", '{}'));
  assert.throws(() => parseCompletionOptions("123", '{"郑伟贤":"*"}'));
});

test("first baseline stays silent; completion notifies only matched owners once, persisting across restart", async () => {
  const s = setup();
  try {
    await s.tick();
    assert.equal(s.sent.length, 0);
    assert.deepEqual(s.workspaces, ["cc", "cq"]);
    assert.ok(s.queries.every(query => query.iteration === "oct" && !query.modified));
    s.backend.status = "done";
    s.time("2026-10-12T09:10:00+08:00");
    await s.tick();
    assert.deepEqual(s.sent.map(item => item.target), ["zheng", "yuan"]);
    assert.match(s.sent[0].content, /后端-村财功能/);
    assert.match(s.sent[0].content, /cc\/stories\/view\/story/);
    assert.equal(s.storyQueries(), 1);
    assert.equal(s.queries[2].modified, ">2026-10-12 08:59:00");
    s.restart();
    await s.tick();
    assert.equal(s.sent.length, 2);
    assert.equal(s.storyQueries(), 1);
  } finally { s.close(); }
});

test("reopened backend discards an undelivered completion notice", async () => {
  const s = setup();
  try {
    await s.tick();
    s.backend.status = "done"; s.failSend(true);
    s.time("2026-10-12T09:10:00+08:00"); await s.tick();
    s.backend.status = "progressing"; s.failSend(false);
    s.time("2026-10-12T09:20:00+08:00"); await s.tick();
    assert.equal(s.sent.length, 0);
    s.backend.status = "done";
    s.time("2026-10-12T09:30:00+08:00"); await s.tick();
    assert.equal(s.sent.length, 2);
  } finally { s.close(); }
});

test("busy monitor serializes queries and pending recipients wait for conversations to unblock", async () => {
  const s = setup();
  try {
    await Promise.all([s.tick(), s.tick(), s.tick()]);
    assert.equal(s.queries.length, 2);
    s.backend.status = "done"; s.block(true);
    s.time("2026-10-12T09:10:00+08:00"); await s.tick();
    assert.equal(s.sent.length, 0);
    s.block(false); s.time("2026-10-12T09:20:00+08:00"); await s.tick();
    assert.equal(s.sent.length, 2);
  } finally { s.close(); }
});

test("historical done tasks and unmarked backend tasks never notify", async () => {
  const s = setup();
  try {
    s.backend.status = "done";
    await s.tick();
    s.time("2026-10-12T09:10:00+08:00");
    s.changed([s.backend, { ...s.backend, id: "unmarked", name: "村财-功能" },
      { ...s.backend, id: "historical", completed: "2026-10-10 09:00:00" }]);
    await s.tick();
    assert.equal(s.sent.length, 0);
    assert.equal(s.storyQueries(), 0);
  } finally { s.close(); }
});

test("overnight catch-up and ten-minute gating, disconnected bots skip queries", async () => {
  const s = setup();
  try {
    await s.tick();
    await s.tick();
    s.time("2026-10-12T09:09:00+08:00"); await s.tick();
    assert.equal(s.queries.length, 2);
    s.backend.status = "done";
    s.time("2026-10-12T20:00:00+08:00"); await s.tick();
    assert.equal(s.queries.length, 2);
    s.time("2026-10-13T09:00:00+08:00"); s.auth(false); await s.tick();
    assert.equal(s.queries.length, 2);
    s.auth(true); await s.tick();
    assert.equal(s.sent.length, 2);
    assert.equal(s.queries[2].modified, ">2026-10-12 08:59:00");
  } finally { s.close(); }
});

test("failed sends survive restart; removed recipients cannot receive queued notices", async () => {
  const s = setup();
  try {
    await s.tick();
    s.backend.status = "done"; s.failSend(true);
    s.time("2026-10-12T09:10:00+08:00"); await s.tick();
    assert.equal(s.sent.length, 0);
    s.failSend(false); s.restart();
    delete (s.options.recipients as Record<string, string>)["袁力思"];
    await s.tick();
    assert.deepEqual(s.sent.map(item => item.target), ["zheng"]);
    s.time("2026-10-12T09:20:00+08:00"); await s.tick();
    assert.equal(s.sent.length, 1);
  } finally { s.close(); }
});

test("query failures do not advance cursor or lose completions, reopen can trigger a new completion", async () => {
  const s = setup();
  try {
    await s.tick();
    s.backend.status = "done"; s.failQuery(true);
    s.time("2026-10-12T09:10:00+08:00"); await s.tick();
    assert.equal(s.sent.length, 0);
    s.failQuery(false); s.time("2026-10-12T09:20:00+08:00"); await s.tick();
    assert.equal(s.queries[4].modified, ">2026-10-12 08:59:00");
    assert.equal(s.sent.length, 2);
    s.backend.status = "progressing"; s.time("2026-10-12T09:30:00+08:00"); await s.tick();
    s.backend.status = "done"; s.time("2026-10-12T09:40:00+08:00"); await s.tick();
    assert.equal(s.sent.length, 4);
  } finally { s.close(); }
});

test("new tasks completed after baseline notify, new monthly iteration baselines stay silent", async () => {
  const s = setup();
  try {
    await s.tick();
    s.changed([{ ...s.backend, id: "new", status: "done", completed: "2026-10-12 09:05:00" }]);
    s.time("2026-10-12T09:10:00+08:00"); await s.tick();
    assert.equal(s.sent.length, 2);
    s.time("2026-11-01T09:00:00+08:00"); await s.tick();
    assert.equal(s.sent.length, 2);
    assert.equal(s.queries.at(-1)?.iteration, "nov");
    assert.equal(s.queries.at(-1)?.modified, undefined);
  } finally { s.close(); }
});
