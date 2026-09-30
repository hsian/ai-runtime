import assert from "node:assert/strict";
import test from "node:test";
import { extractEndpoints } from "./apiDocs.js";

test("Swagger 2 路径包含服务前缀，保留方法和文档定位", () => {
  const result = extractEndpoints({
    swagger: "2.0", basePath: "/api/base", paths: {
      "/historyContract/getPageList": { post: { summary: "分页查询", tags: ["合同 API"], operationId: "getPageListUsingPOST" } },
    },
  }, { name: "基础服务", url: "https://example.com/api/base/doc.html" }, "https://example.com/api/base/doc.html");
  assert.equal(result.length, 1);
  assert.equal(result[0].path, "/api/base/historyContract/getPageList");
  assert.equal(result[0].method, "POST");
  assert.match(result[0].docUrl, /getPageListUsingPOST$/);
});

test("OpenAPI 3 只索引 HTTP 操作", () => {
  const result = extractEndpoints({
    openapi: "3.0.1", servers: [{ url: "https://example.com/api/data" }], paths: {
      "/report/list": { parameters: [], get: { summary: "报表" } },
    },
  }, { name: "数据服务", url: "https://example.com/api/data/doc.html" }, "https://example.com/api/data/doc.html");
  assert.deepEqual(result.map((item) => [item.path, item.method]), [["/api/data/report/list", "GET"]]);
});

test("文档未声明前缀时使用文档入口前缀", () => {
  const result = extractEndpoints({ paths: { "/historyContract/getPageList": { post: {} } } },
    { name: "基础服务", url: "https://example.com/api/base/doc.html" }, "https://example.com/api/base/doc.html");
  assert.equal(result[0].path, "/api/base/historyContract/getPageList");
});

test("兼容 core/doc.htm 文档入口", () => {
  const result = extractEndpoints({ paths: { "/contract/list": { get: { operationId: "listUsingGET" } } } },
    { name: "业务核心服务", url: "https://example.com/api/core/doc.htm" }, "https://example.com/api/core/doc.htm");
  assert.equal(result[0].path, "/api/core/contract/list");
  assert.match(result[0].docUrl, /\/doc\.htm#/);
});
