import assert from "node:assert/strict";
import test from "node:test";

test("debug request uses documented path and does not reuse documentation credentials", async () => {
  process.env.API_DOC_SOURCES = JSON.stringify([{ name: "测试服务", url: "https://mock.example/api/base/doc.html" }]);
  const originalFetch = globalThis.fetch;
  let businessRequest: { url: string; init: RequestInit } | undefined;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === "https://mock.example/api/base/v2/api-docs") {
      return new Response(JSON.stringify({
        swagger: "2.0", basePath: "/api/base",
        paths: { "/{version}/historyContract/getPageList": { post: { summary: "分页查询" } } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    businessRequest = { url, init: init ?? {} };
    return new Response(JSON.stringify({ code: 200, data: { total: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const { executeApiDocRequest } = await import("./apiDocDebug.js");
    const result = await executeApiDocRequest({
      service: "测试服务", method: "POST", path: "/api/base/{version}/historyContract/getPageList",
      url: "https://mock.example/api/base/v1/historyContract/getPageList",
      headers: { token: "user-token", "Content-Type": "application/json", Host: "other.example" },
      body: "{}",
    });
    assert.equal(result.status, 200);
    assert.match(result.body, /"total":0/);
    assert.equal(businessRequest?.url, "https://mock.example/api/base/v1/historyContract/getPageList");
    const headers = businessRequest?.init.headers as Headers;
    assert.equal(headers.get("token"), "user-token");
    assert.equal(headers.get("authorization"), null);
    assert.equal(headers.get("host"), null);
    assert.equal(businessRequest?.init.redirect, "manual");
  } finally { globalThis.fetch = originalFetch; }
});
