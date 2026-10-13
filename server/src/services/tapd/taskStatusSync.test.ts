import assert from "node:assert/strict";
import { after, test } from "node:test";
process.env.GIT_ACCESS_TOKEN = "test-only";
const { writeTaskStatus } = await import("./taskStatusSync.js");
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; });
const cfg = { apiBase: "https://api.tapd.cn", clientId: "test", clientSecret: "test", workspaceId: "123", workspaces: [] };
const target = { workspaceId: "123", taskId: "1123456789000000001" };

function mock(initial: string, owner = "alice;", accept = true) {
  let status = initial;
  const writes: URLSearchParams[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/tokens/request_token") return Response.json({ status: 1, data: { access_token: "test", expires_in: 3600 } });
    assert.equal(url.pathname, "/tasks", "must not update parent story or bug");
    if (init?.method === "POST") {
      const body = new URLSearchParams(String(init.body));
      assert.equal(body.get("workspace_id"), target.workspaceId);
      assert.equal(body.get("id"), target.taskId);
      assert.equal(body.get("current_user"), "alice");
      writes.push(body);
      if (accept) status = body.get("status")!;
      return Response.json({ status: 1, data: { Task: { status } } });
    }
    assert.equal(url.searchParams.get("id"), target.taskId);
    return Response.json({ status: 1, data: [{ Task: { id: target.taskId, owner, status } }] });
  };
  return writes;
}

test("start and completion write only the assigned task and verify the resulting status", async () => {
  const writes = mock("open");
  await writeTaskStatus(target, "alice", "progressing", cfg);
  await writeTaskStatus(target, "alice", "done", cfg);
  assert.deepEqual(writes.map(body => body.get("status")), ["progressing", "done"]);
});
test("retry is idempotent when task is already completed", async () => {
  const writes = mock("done");
  await writeTaskStatus(target, "alice", "done", cfg);
  assert.equal(writes.length, 0);
});
test("changed assignee prevents external writes", async () => {
  const writes = mock("progressing", "bob;");
  await assert.rejects(writeTaskStatus(target, "alice", "done", cfg), /负责人已变化/);
  assert.equal(writes.length, 0);
});
test("a success response without effective status update remains a failure", async () => {
  mock("progressing", "alice;", false);
  await assert.rejects(writeTaskStatus(target, "alice", "done", cfg), /未生效/);
});
