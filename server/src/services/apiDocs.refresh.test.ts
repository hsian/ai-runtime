import assert from "node:assert/strict";
import test from "node:test";

test("手动刷新会绕过有效缓存并更新搜索结果", async () => {
  const originalSources = process.env.API_DOC_SOURCES;
  const originalFetch = globalThis.fetch;
  process.env.API_DOC_SOURCES = JSON.stringify([{ name: "测试服务", url: "https://mock.example/api/base/doc.html" }]);
  let downloads = 0;
  globalThis.fetch = async () => {
    downloads += 1;
    const path = downloads === 1 ? "/old/list" : "/new/list";
    return new Response(JSON.stringify({ swagger: "2.0", basePath: "/api/base", paths: { [path]: { get: { summary: "列表" } } } }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  try {
    const { searchApiDocs, refreshApiDocs } = await import("./apiDocs.js");
    assert.equal((await searchApiDocs("/old/list")).results.length, 1);
    assert.equal((await searchApiDocs("/old/list")).results.length, 1);
    assert.equal(downloads, 1);
    assert.equal((await refreshApiDocs("/new/list")).results.length, 1);
    assert.equal(downloads, 2);
    assert.equal((await searchApiDocs("/old/list")).results.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalSources === undefined) delete process.env.API_DOC_SOURCES;
    else process.env.API_DOC_SOURCES = originalSources;
  }
});
