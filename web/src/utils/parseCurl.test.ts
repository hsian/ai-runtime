import assert from "node:assert/strict";
import test from "node:test";
import { parseCurl } from "./parseCurl.js";

test("parses Chrome Copy as cURL (bash) without executing it", () => {
  const result = parseCurl("curl 'https://cc-test.example/api/core/v1/historyContract/getPageList' -H 'token: test-token' -H 'content-type: application/json' --data-raw '{\"current\":1}' --compressed");
  assert.equal(result.method, "POST");
  assert.equal(result.headers.token, "test-token");
  assert.equal(result.body, '{"current":1}');
});

test("parses cmd caret continuations and rejects extra commands", () => {
  const result = parseCurl('curl "https://example.com/api/base/v1/items" ^\n  -X POST ^\n  -H "sessionid: abc" ^\n  --data-raw "{^"page^":1}"');
  assert.equal(result.method, "POST");
  assert.equal(result.body, '{"page":1}');
  assert.throws(() => parseCurl("curl https://example.com/api/base/v1/items && echo bad"), /多个地址|额外命令/);
});

test("accepts caret quoted URLs from Copy as cURL (cmd)", () => {
  const result = parseCurl('curl ^"https://example.com/api/base/v1/items^" ^\n  -H ^"sessionid: abc^"');
  assert.equal(result.url, "https://example.com/api/base/v1/items");
  assert.equal(result.headers.sessionid, "abc");
});
