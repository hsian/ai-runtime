import assert from "node:assert/strict";
import { test } from "node:test";

process.env.GIT_ACCESS_TOKEN = "test-only";
const { downloadImagesFromHtml } = await import("./tapdDescriptionImages.js");
const cfg = { apiBase: "https://api.tapd.cn", clientId: "test", clientSecret: "test",
  workspaceId: "123", workspaces: [{ id: "123", name: "test" }] };

test("strict TAPD image downloads reject redirects to private or unrelated hosts", async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    calls.push(url.href);
    if (url.pathname === "/tokens/request_token") return Response.json({ status: 1,
      data: { access_token: "synthetic-token", expires_in: 7200 } });
    if (url.hostname === "api.tapd.cn") return Response.json({ status: 1,
      data: { Attachment: { download_url: "https://files.tapd.cn/redirect.png" } } });
    if (url.pathname === "/redirect.png") return new Response(null, { status: 302,
      headers: { location: "http://127.0.0.1/private" } });
    return new Response(null, { status: 403 });
  };
  try {
    const report = await downloadImagesFromHtml('<img src="https://files.tapd.cn/tfl/test.png">', "123", cfg, true);
    assert.equal(report.images.length, 0);
    assert.equal(report.failedUrls.length, 1);
    assert.ok(!calls.some(url => url.includes("127.0.0.1")));
  } finally { globalThis.fetch = original; }
});

test("strict image mode reads a trusted download and preserves its MIME", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.hostname === "api.tapd.cn") return Response.json({ status: 1,
      data: { Attachment: { download_url: "https://files.tapd.cn/good.png" } } });
    return new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), { headers: { "content-type": "image/png" } });
  };
  try {
    const report = await downloadImagesFromHtml('<img src="https://files.tapd.cn/tfl/test.png">', "123", cfg, true);
    assert.equal(report.images.length, 1);
    assert.equal(report.images[0].mime, "image/png");
    assert.equal(report.failedUrls.length, 0);
  } finally { globalThis.fetch = original; }
});
