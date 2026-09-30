import assert from "node:assert/strict";
import test from "node:test";
import { safeDebugHeaders, validateDebugTarget } from "./apiDocDebug.js";

const source = "https://cc-test.b2bwings.com/api/core/doc.htm";
const path = "/api/core/{version}/historyContract/getPageList";

test("only the selected documented endpoint on its configured origin is accepted", () => {
  const valid = validateDebugTarget(source, path, "https://cc-test.b2bwings.com/api/core/v1/historyContract/getPageList?page=1");
  assert.equal(valid.search, "?page=1");
  assert.throws(() => validateDebugTarget(source, path, "https://other.example/api/core/v1/historyContract/getPageList"));
  assert.throws(() => validateDebugTarget(source, path, "https://cc-test.b2bwings.com/api/data/v1/historyContract/getPageList"));
  assert.throws(() => validateDebugTarget(source, path, "https://cc-test.b2bwings.com/api/core/%2F/historyContract/getPageList"));
  assert.throws(() => validateDebugTarget(source, path, "http://cc-test.b2bwings.com/api/core/v1/historyContract/getPageList"));
});

test("request headers retain business authentication but remove transport headers", () => {
  const headers = safeDebugHeaders({ sessionid: "test-token", channel: "admin", Host: "other.example", "Content-Length": "999" });
  assert.equal(headers.get("sessionid"), "test-token");
  assert.equal(headers.get("channel"), "admin");
  assert.equal(headers.get("host"), null);
  assert.equal(headers.get("content-length"), null);
});
