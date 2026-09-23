import assert from "node:assert/strict";
import test from "node:test";

import { buildBugDraftPrompt, parseBugDraft } from "./bugDraft.js";

test("parses a bug draft with optional details left empty", () => {
  const draft = parseBugDraft(JSON.stringify({
    title: "合同复核搜索后列表为空",
    preconditions: "",
    steps: "进入合同复核，搜索合同编号",
    actualResult: "无结果",
    expectedResult: "显示对应合同",
    evidence: "",
  }));
  assert.equal(draft.preconditions, "");
  assert.equal(draft.actualResult, "无结果");
});

test("rejects incomplete AI output instead of silently fabricating fields", () => {
  assert.throws(() => parseBugDraft('{"title":"列表为空"}'), /有效的缺陷草稿/);
});

test("marks implementation summary as background rather than defect evidence", () => {
  const prompt = buildBugDraftPrompt({ prompt: "搜索合同无结果", implementationSummary: "修改了查询接口" });
  assert.match(prompt, /实现总结仅用于理解背景/);
  assert.match(prompt, /搜索合同无结果/);
});
