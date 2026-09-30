import assert from "node:assert/strict";
import test from "node:test";
import { formatApiDocMarkdown } from "./apiDocExport.js";

test("导出文档包含接口、请求参数、响应和引用模型", () => {
  const markdown = formatApiDocMarkdown({
    endpoint: {
      service: "业务核心服务", method: "POST", path: "/api/core/historyContract/getPageList",
      summary: "分页查询", tag: "合同 API", docUrl: "https://example.com/doc.html", rawPath: "/historyContract/getPageList",
    },
    operation: {
      parameters: [{ name: "pageNum", in: "query", type: "integer" }],
      responses: { 200: { schema: { $ref: "#/definitions/PageResult" } } },
    },
    schemas: { "#/definitions/PageResult": { properties: { total: { type: "integer" } } } },
  });
  assert.match(markdown, /POST \/api\/core\/historyContract\/getPageList/);
  assert.match(markdown, /pageNum/);
  assert.match(markdown, /responses/);
  assert.match(markdown, /PageResult/);
  assert.match(markdown, /total/);
});
