import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import ExcelJS from "exceljs";

import { parseTestCaseDocument } from "../dist/services/testCases/testCaseSchema.js";
import { buildTestCaseWorkbook } from "../dist/services/testCases/testCaseWorkbookService.js";

const explicitOutputPath = process.argv[2];
const outputPath = resolve(explicitOutputPath || "data/uploads/test-case-verification.xlsx");
const document = parseTestCaseDocument(JSON.stringify({
  moduleName: "示例模块",
  functionDescription: "验证示例功能的页面交互和数据展示",
  implementationAssessment: {
    recommendedResult: "部分实现",
    summary: "主要页面和交互已经存在，部分异常场景仍需人工确认。",
    evidence: ["示例页面包含需求所需的查询入口和结果展示逻辑。"],
    gaps: ["异常数据提示需要在测试环境中执行确认。"],
  },
  cases: [
    {
      priority: "高",
      levelOneModule: "示例功能",
      levelTwoModule: "查询页面",
      requirementPoint: "查询条件",
      testPoint: "有效条件查询",
      preconditions: "用户已进入示例查询页面",
      steps: ["输入有效查询条件", "点击查询按钮", "查看结果列表"],
      expectedResult: "结果列表显示符合条件的数据",
    },
    {
      priority: "中",
      levelOneModule: "示例功能",
      levelTwoModule: "查询页面",
      requirementPoint: "查询条件",
      testPoint: "空条件查询",
      preconditions: "用户已进入示例查询页面",
      steps: ["清空查询条件", "点击查询按钮", "查看页面反馈"],
      expectedResult: "页面按业务规则展示数据或提示用户补充条件",
    },
  ],
}));

const normalizedAssessment = parseTestCaseDocument(JSON.stringify({
  moduleName: "格式兼容验证",
  functionDescription: "验证推荐依据和缺口允许使用字符串",
  implementationAssessment: {
    recommendedResult: "部分实现",
    summary: "存在需要人工确认的内容。",
    evidence: "页面具备查询入口；结果区域能够展示数据",
    gaps: "异常提示需要人工验证",
  },
  cases: [{
    priority: "中",
    levelOneModule: "示例功能",
    levelTwoModule: "查询页面",
    requirementPoint: "查询",
    testPoint: "查询结果",
    preconditions: "用户已进入页面",
    steps: ["点击查询"],
    expectedResult: "页面展示查询结果",
  }],
}));
assert.deepEqual(normalizedAssessment.implementationAssessment?.evidence, ["页面具备查询入口", "结果区域能够展示数据"]);
assert.deepEqual(normalizedAssessment.implementationAssessment?.gaps, ["异常提示需要人工验证"]);

const job = {
  jobId: "verification",
  projectId: "verification",
  ownerId: "verification",
  status: "completed",
  prompt: "验证示例功能测试用例",
  taskMode: "test-case",
  testCaseDocument: document,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const output = await buildTestCaseWorkbook(job);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, output);

const workbook = new ExcelJS.Workbook();
await workbook.xlsx.load(output);
const worksheet = workbook.getWorksheet("需求 #1022756");
const implementationReference = workbook.getWorksheet("实现参考");
assert(worksheet, "用例工作表应保留");
assert.equal(workbook.getWorksheet("前言")?.name, "前言");
assert.equal(workbook.getWorksheet("目录")?.name, "目录");
assert.equal(workbook.worksheets.length, 5);
assert(implementationReference, "实现参考工作表应生成");
assert.equal(implementationReference.getCell("C3").value, "部分实现");
assert.match(String(implementationReference.getCell("C11").value), /实际结果.*测试人员/);
assert.equal(worksheet.getCell("B5").isMerged, true);
assert.equal(worksheet.getCell("D5").value, "功能模块");
assert.equal(worksheet.getCell("B7").value, 1);
assert.equal(worksheet.getCell("C7").value, "高");
assert.match(String(worksheet.getCell("I7").value), /1、输入有效查询条件/);
assert.equal(worksheet.getCell("K7").value, null);
assert(Object.keys(worksheet.dataValidations.model).length >= 3, "模板数据验证应保留");
console.log(`测试用例工作簿验证通过: ${outputPath}`);
if (!explicitOutputPath) await rm(outputPath, { force: true });
