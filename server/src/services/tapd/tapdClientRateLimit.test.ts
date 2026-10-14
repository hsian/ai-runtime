import assert from "node:assert/strict";
import { after, test } from "node:test";
process.env.GIT_ACCESS_TOKEN = "test-only";
const { tapdRequest, tapdPost, getAccessToken } = await import("./tapdClient.js");
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; });
const cfg = { apiBase: "https://tapd.invalid", clientId: "rate-test", clientSecret: "test", workspaceId: "123", workspaces: [] };

test("concurrent identical reads and token acquisition are coalesced; subsequent manual reads are fresh", async () => {
  let tokens = 0, reads = 0, status = "open";
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname === "/tokens/request_token") { tokens++; return Response.json({ status: 1, data: { access_token: "token", expires_in: 3600 } }); }
    reads++;
    return Response.json({ status: 1, data: { status } });
  };
  const result = await Promise.all([
    tapdRequest<{ status: string }>(cfg, "/tasks", { id: "1", workspace_id: "123" }),
    tapdRequest<{ status: string }>(cfg, "/tasks", { workspace_id: "123", id: "1" }),
    getAccessToken(cfg), getAccessToken(cfg),
  ]);
  assert.equal(tokens, 1);
  assert.equal(reads, 1);
  assert.equal(result[0].data.status, "open");
  status = "done";
  assert.equal((await tapdRequest<{ status: string }>(cfg, "/tasks", { id: "1", workspace_id: "123" })).data.status, "done");
  assert.equal(reads, 2);
});

test("HTML 429 is retried before parsing JSON; writes use the same pacing queue", async () => {
  let attempts = 0;
  const starts: number[] = [];
  globalThis.fetch = async (_input, init) => {
    starts.push(Date.now());
    if (++attempts === 1) return new Response("<html>Too many requests</html>", { status: 429, headers: { "Retry-After": "0" } });
    return Response.json({ status: 1, data: { method: init?.method || "GET" } });
  };
  const [read, write] = await Promise.all([
    tapdRequest<{ method: string }>(cfg, "/iterations", { workspace_id: "123" }),
    tapdPost<{ method: string }>(cfg, "/bugs", { workspace_id: "123", id: "2", status: "resolved" }),
  ]);
  assert.equal(read.data.method, "GET");
  assert.equal(write.data.method, "POST");
  assert.equal(attempts, 3);
  for (let index = 1; index < starts.length; index++) assert.ok(starts[index] - starts[index - 1] >= 1400, "requests must share an interval even during 429 retry");
});

test("failed reads are not retained and credential changes cannot reuse another token", async () => {
  let reads = 0, tokens = 0;
  globalThis.fetch = async input => {
    if (new URL(String(input)).pathname === "/tokens/request_token") { tokens++; return Response.json({ status: 1, data: { access_token: "different-token", expires_in: 3600 } }); }
    if (++reads === 1) return Response.json({ status: 0, info: "temporary failure" });
    return Response.json({ status: 1, data: [] });
  };
  await assert.rejects(tapdRequest(cfg, "/tasks", { id: "retry" }), /temporary failure/);
  await tapdRequest(cfg, "/tasks", { id: "retry" });
  assert.equal(reads, 2);
  assert.equal(await getAccessToken({ ...cfg, clientSecret: "changed" }), "different-token");
  assert.equal(tokens, 1);
});
