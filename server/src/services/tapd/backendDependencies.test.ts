import assert from "node:assert/strict";
import { after, test } from "node:test";
process.env.GIT_ACCESS_TOKEN = "test-only";
const { loadBackendDependencies } = await import("./tapdClient.js");
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; });
const cfg = { apiBase: "https://tapd.invalid", clientId: "test", clientSecret: "test", workspaceId: "123", workspaces: [] };

test("associate only same-story backend tasks, including other iterations and orphan fronts", async () => {
  const searchedNames: string[] = [];
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname === "/tokens/request_token") return Response.json({ status: 1, data: { access_token: "test", expires_in: 3600 } });
    assert.equal(url.pathname, "/tasks");
    assert.equal(url.searchParams.get("workspace_id"), "123");
    assert.equal(url.searchParams.has("iteration_id"), false);
    assert.equal(url.searchParams.get("story_id"), "s1,s2");
    const name = url.searchParams.get("name")!;
    searchedNames.push(name);
    assert.ok(["后端", "数据"].includes(name));
    if (name === "数据") return Response.json({ status: 1, data: [
      { Task: { id: "d1", name: " 数据 - 报表初始化", story_id: "s1", iteration_id: "earlier", status: "done" } },
      { Task: { id: "d2", name: "数据-清洗", story_id: "s2", status: "progressing" } },
      { Task: { id: "data-feature", name: "数据查询", story_id: "s1", status: "open" } },
      { Task: { id: "d3", name: "数据 - 无关需求", story_id: "s3", status: "done" } },
      { Task: { id: "b1", name: "后端 - 字段扩展", story_id: "s1", iteration_id: "earlier", status: "done", owner: "backend-a" } },
    ] });
    return Response.json({ status: 1, data: [
      { Task: { id: "b1", name: "后端 - 字段扩展", story_id: "s1", iteration_id: "earlier", status: "done", owner: "backend-a" } },
      { Task: { id: "b2", name: "后端 - 导出接口", story_id: "s1", iteration_id: "current", status: "progressing" } },
      { Task: { id: "b3", name: "后端 - 无关需求", story_id: "s3", status: "open" } },
      { Task: { id: "other-front", name: "前端 - 其他成员", story_id: "s1", status: "open" } },
      { Task: { id: "b4", name: "后端 - 孤立前端对应需求", story_id: "s2", status: "done" } },
    ] });
  };
  const result = await loadBackendDependencies({ workspaceId: "123", iterationId: "current", stories: [{ id: "s1", name: "报表", tasks: [{ id: "f1", name: "前端 - 报表" }] }], orphanTasks: [{ id: "f2", name: "前端 - 孤立项", story_id: "s2" }] }, cfg);
  assert.deepEqual(searchedNames, ["后端", "数据"]);
  assert.deepEqual(result.f1.map(task => task.id), ["b1", "b2", "d1"]);
  assert.equal(result.f1[0].owner, "backend-a");
  assert.deepEqual(result.f2.map(task => task.id), ["b4", "d2"]);
});

test("unlinked tasks do not guess dependencies or fetch the entire workspace", async () => {
  globalThis.fetch = async () => { throw new Error("should not fetch"); };
  assert.deepEqual(await loadBackendDependencies({ workspaceId: "123", iterationId: "current", stories: [], orphanTasks: [{ id: "f1", name: "前端 - 未关联" }] }, cfg), {});
});
