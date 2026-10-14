import assert from "node:assert/strict";
import { after, test } from "node:test";
process.env.GIT_ACCESS_TOKEN = "test-only";
const { writeTaskStatus, resolveBug } = await import("./taskStatusSync.js");
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

const bugTarget = { workspaceId: "123", bugId: "1123456789000000002" };
function mockBug(options: { status?: string; owner?: string; reporter?: string; acceptStatus?: boolean; acceptOwner?: boolean; resolvedKey?: string; missingStatus?: boolean } = {}) {
  let status = options.status || "in_progress";
  let owner = options.owner || "alice;";
  const reporter = options.reporter ?? "tester";
  const resolvedKey = options.resolvedKey || "resolved";
  const writes: URLSearchParams[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/tokens/request_token") return Response.json({ status: 1, data: { access_token: "test", expires_in: 3600 } });
    if (url.pathname === "/bugs/get_fields_info") {
      assert.equal(url.searchParams.get("workspace_id"), bugTarget.workspaceId);
      return Response.json({ status: 1, data: { status: { options: options.missingStatus ? {} : { [resolvedKey]: "已解决", closed: "已关闭", verified: "已验证" } } } });
    }
    assert.equal(url.pathname, "/bugs", "must only update this defect");
    if (init?.method === "POST") {
      const body = new URLSearchParams(String(init.body));
      assert.equal(body.get("workspace_id"), bugTarget.workspaceId);
      assert.equal(body.get("id"), bugTarget.bugId);
      assert.equal(body.get("current_user"), "alice");
      assert.equal(body.get("reporter"), null, "creator must never be rewritten");
      writes.push(body);
      if (options.acceptStatus !== false) status = body.get("status")!;
      if (options.acceptOwner !== false) owner = body.get("current_owner")!;
      return Response.json({ status: 1, data: { Bug: { status, current_owner: owner } } });
    }
    assert.equal(url.searchParams.get("id"), bugTarget.bugId);
    return Response.json({ status: 1, data: [{ Bug: { id: bugTarget.bugId, status, current_owner: owner, reporter } }] });
  };
  return writes;
}

test("Bug completion uses project workflow and assigns the fresh reporter in one write", async () => {
  const writes = mockBug({ resolvedKey: "custom_resolved", reporter: "测试同事" });
  await resolveBug(bugTarget, "alice", cfg);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].get("status"), "custom_resolved");
  assert.equal(writes[0].get("current_owner"), "测试同事;");
});

test("Bug retry after successful handoff is idempotent although operator no longer owns it", async () => {
  const writes = mockBug({ status: "resolved", owner: "tester;" });
  await resolveBug(bugTarget, "alice", cfg);
  assert.equal(writes.length, 0);
});

test("Bug sync rejects missing reporter, unrelated reassignment and absent workflow status", async () => {
  let writes = mockBug({ reporter: "" });
  await assert.rejects(resolveBug(bugTarget, "alice", cfg), /创建人/);
  assert.equal(writes.length, 0);
  writes = mockBug({ owner: "bob;" });
  await assert.rejects(resolveBug(bugTarget, "alice", cfg), /处理人已变化/);
  assert.equal(writes.length, 0);
  writes = mockBug({ missingStatus: true });
  await assert.rejects(resolveBug(bugTarget, "alice", cfg), /已解决/);
  assert.equal(writes.length, 0);
});

test("Bug sync verifies both status and owner instead of trusting successful API response", async () => {
  mockBug({ acceptOwner: false });
  await assert.rejects(resolveBug(bugTarget, "alice", cfg), /未生效/);
  mockBug({ acceptStatus: false });
  await assert.rejects(resolveBug(bugTarget, "alice", cfg), /未生效/);
});

test("Bug already accepted by testing is never reopened for completion retry", async () => {
  const writes = mockBug({ status: "closed", owner: "tester;" });
  await assert.rejects(resolveBug(bugTarget, "alice", cfg), /不会回退/);
  assert.equal(writes.length, 0);
});
