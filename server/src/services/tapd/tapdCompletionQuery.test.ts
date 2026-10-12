import assert from "node:assert/strict";
import { after, test } from "node:test";

process.env.GIT_ACCESS_TOKEN = "test-only";
const { listIterationTasks, listStoryTasks } = await import("./tapdClient.js");
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; });
const cfg = { apiBase: "https://api.tapd.cn", clientId: "test", clientSecret: "test", workspaceId: "123", workspaces: [] };

test("incremental task query preserves timestamp operator, iteration/workspace, stable pagination and long IDs", async () => {
  const queries: URL[] = [];
  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input));
    if (url.pathname === "/tokens/request_token") return Response.json({ status: 1, data: { access_token: "test", expires_in: 3600 } });
    assert.ok(options?.signal);
    queries.push(url);
    const page = url.searchParams.get("page");
    return Response.json({ status: 1, data: page === "1" ? Array.from({ length: 200 }, (_, i) =>
      ({ Task: { id: `112345678900000${String(i).padStart(4, "0")}`, name: "后端-测试", status: "done" } })) : [] });
  };
  const result = await listIterationTasks("iteration", { workspaceId: "456", modified: ">2026-10-12 08:59:00" }, cfg);
  assert.equal(result.length, 200);
  assert.equal(result[0].id, "1123456789000000000");
  assert.equal(queries.length, 2);
  for (const query of queries) {
    assert.equal(query.searchParams.get("workspace_id"), "456");
    assert.equal(query.searchParams.get("iteration_id"), "iteration");
    assert.equal(query.searchParams.get("modified"), ">2026-10-12 08:59:00");
    assert.equal(query.searchParams.get("order"), "id ASC");
  }
});

test("frontend lookup is scoped by story ID and project, not by title", async () => {
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    assert.equal(url.searchParams.get("workspace_id"), "456");
    assert.equal(url.searchParams.get("story_id"), "1123456789000000001");
    assert.equal(url.searchParams.get("name"), null);
    return Response.json({ status: 1, data: [] });
  };
  assert.deepEqual(await listStoryTasks("1123456789000000001", "456", cfg), []);
});

test("pagination overflow fails instead of silently returning an incomplete snapshot", async () => {
  let pages = 0;
  globalThis.fetch = async () => {
    pages++;
    return Response.json({ status: 1, data: Array.from({ length: 200 }, () => ({ Task: { id: "1", name: "后端" } })) });
  };
  await assert.rejects(listIterationTasks("iteration", { workspaceId: "456" }, cfg), /分页上限/);
  assert.equal(pages, 50);
});
