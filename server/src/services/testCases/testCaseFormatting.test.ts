import assert from "node:assert/strict";
import { test } from "node:test";

import type { TestCaseDocument, TestCaseItem } from "../../types.js";
import { normalizeTestCaseDocument, normalizeTestCaseSteps } from "./testCaseFormatting.js";
import { parseTestCaseDocument } from "./testCaseSchema.js";

const baseCase: TestCaseItem = {
  caseNumber: 9, priority: "高", levelOneModule: "（账套复原）合同管理",
  levelTwoModule: "履约中合同", requirementPoint: "查询", testPoint: "查询有凭证的合同",
  preconditions: "有履约中合同，未提供是否无固定期限信息，已进入【履约中合同】页面",
  steps: ["点击【查询】按钮"], expectedResult: "列表显示符合条件的合同",
};
const fixture: TestCaseDocument = {
  moduleName: "合同管理", functionDescription: "合同查询",
  implementationAssessment: { recommendedResult: "部分实现", summary: "查询已实现", evidence: [], gaps: [] },
  cases: [baseCase],
};

test("legacy step separators and numbering normalize to single actions without changing business values", () => {
  assert.deepEqual(normalizeTestCaseSteps([
    '1、点击【选择图片】<BR />2. 选择“合同.png”\\n3）点击【上传】\r\n',
    '4、核对“合同年限”为1.5年',
  ]), ['点击【选择图片】', '选择“合同.png”', '点击【上传】', '核对“合同年限”为1.5年']);
  assert.deepEqual(normalizeTestCaseSteps(['1、点击【返回】按钮']), ['点击【返回】按钮']);
});

test("grouping is hierarchical, stable and renumbers cases without altering priority or business conditions", () => {
  const cases = [
    baseCase,
    { ...baseCase, levelTwoModule: "历史合同档案", testPoint: "历史合同" },
    { ...baseCase, requirementPoint: "详情", testPoint: "合同详情" },
    { ...baseCase, levelOneModule: "审批中心", testPoint: "审批查询" },
    { ...baseCase, priority: "低" as const, testPoint: "查询无凭证的合同" },
    { ...baseCase, levelTwoModule: "历史合同档案", testPoint: "历史合同空列表" },
  ];
  const normalized = normalizeTestCaseDocument({ ...fixture, cases });
  assert.deepEqual(normalized.cases.map(item => item.testPoint), [
    "查询有凭证的合同", "查询无凭证的合同", "合同详情", "历史合同", "历史合同空列表", "审批查询",
  ]);
  assert.deepEqual(normalized.cases.map(item => item.caseNumber), [1, 2, 3, 4, 5, 6]);
  assert.equal(normalized.cases[1].priority, "低");
  assert.equal(normalized.cases[0].preconditions, baseCase.preconditions);
  assert.equal(normalized.cases[0].levelOneModule, "（账套复原）合同管理");
  assert.deepEqual(normalizeTestCaseDocument(normalized), normalized);
  assert.equal(cases[0].caseNumber, 9, "does not mutate stored input");
});

test("parser normalizes before checking actual step count and rejects empty or oversized steps", () => {
  const parseSteps = (steps: string[]) => parseTestCaseDocument(JSON.stringify({
    ...fixture, cases: [{ ...baseCase, steps }],
  }));
  assert.deepEqual(parseSteps(['1、点击【查询】<br>2、查看列表']).cases[0].steps, ['点击【查询】', '查看列表']);
  assert.throws(() => parseSteps(['<br>\\n1、']), /steps/);
  assert.throws(() => parseSteps([Array.from({ length: 31 }, () => '点击【查询】').join('<br>')]), /steps/);
});
