import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { test } from "node:test";

process.env.GIT_ACCESS_TOKEN = "test-only";
process.env.API_DOC_SOURCES = JSON.stringify([{ name: "基础服务", url: "https://docs.invalid/base/doc.html" },
  { name: "故障服务", url: "https://unavailable.invalid/doc.html" }]);
process.env.API_DOC_USERNAME = "test-user";
process.env.API_DOC_PASSWORD = "test-secret-not-in-snapshot";

test("analysis/execution snapshots refresh unchanged endpoints, include fields/models and support both read-only files and queries", async () => {
  const originalFetch = globalThis.fetch;
  let latest = false; let downloads = 0;
  globalThis.fetch = async input => {
    if (new URL(String(input)).hostname === "unavailable.invalid") return new Response("offline", { status: 503 });
    downloads++;
    return Response.json({ swagger: "2.0", basePath: "/base", paths: {
      "/report/list": { parameters: [{ name: "regionId", in: "query", type: "string", required: true }],
        post: { summary: "发生额核对查询", parameters: [{ name: "body", in: "body", schema: { $ref: "#/definitions/Query" } }],
          responses: { "200": { schema: { $ref: "#/definitions/Result" } } } } },
    }, definitions: {
      Query: { type: "object", properties: { ...(latest ? { amountCheck: { type: "string", enum: ["match", "mismatch"], description: "发生额是否一致" } } : {}) } },
      Result: { type: "object", properties: { rows: { type: "array", items: { $ref: "#/definitions/Row" } } } },
      Row: { type: "object", properties: { oldBalance: { type: "number" }, ...(latest ? { incomeAmount: { type: "number", description: "收入发生额" } } : {}) } },
    } });
  };
  const { prepareAgentApiDocs } = await import("./agentApiDocs.js");
  const directories: string[] = [];
  try {
    const first = await prepareAgentApiDocs();
    const getIndex = async (context: string) => {
      const path = /接口索引文件 ([^\r\n]+index\.jsonl)/.exec(context)![1];
      directories.push(dirname(path));
      const entries = (await readFile(path, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
      return { entries, path };
    };
    const original = await getIndex(first.context);
    assert.equal(original.entries[0].path, "/base/report/list");
    const oldDetail = JSON.parse(await readFile(original.entries[0].detailFile, "utf8"));
    assert.equal(oldDetail.schemas["#/definitions/Row"].properties.incomeAmount, undefined);
    await first.dispose();
    latest = true;
    const second = await prepareAgentApiDocs();
    try {
      assert.equal(downloads, 2, "new stage bypasses the ten-minute cache even when the interface path is unchanged");
      const current = await getIndex(second.context);
      const detail = JSON.parse(await readFile(current.entries[0].detailFile, "utf8"));
      assert.equal(detail.operation.parameters[0].name, "regionId");
      assert.equal(detail.schemas["#/definitions/Row"].properties.incomeAmount.description, "收入发生额");
      assert.deepEqual(detail.schemas["#/definitions/Query"].properties.amountCheck.enum, ["match", "mismatch"]);
      assert.match(second.context, /故障服务：HTTP 503/);
      const script = join(dirname(current.path), "api-doc-query.cjs");
      const run = promisify(execFile);
      const result = JSON.parse((await run(process.execPath, [script, "search", "发生额"])).stdout);
      assert.equal(result.results[0].path, "/base/report/list");
      const queried = JSON.parse((await run(process.execPath, [script, "detail", "基础服务", "POST", "/base/report/list"])).stdout);
      assert.equal(queried.schemas["#/definitions/Row"].properties.incomeAmount.type, "number");
      const missing = JSON.parse((await run(process.execPath, [script, "detail", "基础服务", "GET", "/missing"])).stdout);
      assert.match(missing.error, /未找到/);
      for (const file of await readdir(dirname(current.path))) assert.ok(!(await readFile(join(dirname(current.path), file), "utf8")).includes("test-secret-not-in-snapshot"));
    } finally { await second.dispose(); }
    for (const directory of directories) await assert.rejects(stat(directory), /ENOENT/);
  } finally { globalThis.fetch = originalFetch; }
});
