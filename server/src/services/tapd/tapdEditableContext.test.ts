import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTapdEditableHtml,
  cleanTapdEditableHtml,
  normalizeTapdEditableContent,
} from "./tapdEditableContext.js";

test("cleans active content and unsafe attributes from TAPD HTML", () => {
  const cleaned = cleanTapdEditableHtml(
    '<p onclick="alert(1)">正文<script>alert(2)</script><img src="javascript:alert(3)" onerror="alert(4)"></p>'
  );
  assert.equal(cleaned.includes("script"), false);
  assert.equal(cleaned.includes("onclick"), false);
  assert.equal(cleaned.includes("onerror"), false);
  assert.equal(cleaned.includes("javascript:"), false);
  assert.match(cleaned, /正文/);
});

test("combines description and comments and numbers all images", () => {
  const html = buildTapdEditableHtml(
    '<p>原始需求<img src="/one.png"></p>',
    [{ id: "1", author: "测试人员", created: "2026-09-17 10:00:00", description: '<p>评论补充<img src="/two.png"></p>' }]
  );
  assert.match(html, /需求描述/);
  assert.match(html, /评论与补充（1）/);
  assert.match(html, /测试人员/);
  assert.match(html, /data-source-index="1"/);
  assert.match(html, /data-source-index="2"/);
});

test("returns retained source indexes but renumbers edited images continuously", () => {
  const result = normalizeTapdEditableContent(
    '<section><p>先放原图3<img src="blob:local" data-source-index="3"></p><p>再放原图1<img data-source-index="1"></p><img data-source-index="3"><img data-source-index="999"></section>'
  );
  assert.deepEqual(result.retainedImageIndexes, [3, 1]);
  assert.match(result.description, /先放原图3\s*\[配图1\]/);
  assert.match(result.description, /再放原图1\s*\[配图2\]/);
  assert.doesNotMatch(result.description, /配图3/);
  assert.doesNotMatch(result.description, /配图999/);
  assert.equal(result.html.includes("blob:"), false);
});
