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
      requirementPoint: "查询",
      testPoint: "有效条件查询",
      preconditions: "存在符合条件的数据，用户已进入【示例查询】页面",
      steps: ["1、输入有效查询条件<br>2、点击【查询】按钮\\n3、查看结果列表"],
      expectedResult: "结果列表显示符合条件的数据",
    },
    {
      priority: "中", levelOneModule: "示例功能", levelTwoModule: "历史页面",
      requirementPoint: "查询", testPoint: "历史记录查询", preconditions: "有历史记录",
      steps: ["进入【历史页面】", "点击【查询】按钮"], expectedResult: "展示已有历史记录",
    },
    {
      priority: "中",
      levelOneModule: "示例功能",
      levelTwoModule: "查询页面",
      requirementPoint: "查询",
      testPoint: "空条件查询",
      preconditions: "用户已进入示例查询页面",
      steps: ["清空查询条件", "点击【查询】按钮", "查看页面反馈"],
      expectedResult: "查询条件非必填时展示全部数据；条件是否必填待确认",
    },
  ],
}));

const job = {
  jobId: "verification",
  projectId: "verification",
  ownerId: "verification",
  status: "completed",
  prompt: "验证示例功能测试用例",
  taskMode: "test-case",
  // Export also normalizes older stored documents that bypass the current parser.
  testCaseDocument: {
    ...document,
    cases: [document.cases[0], document.cases[2], document.cases[1]].map((item, index) => ({
      ...item, caseNumber: 100 + index,
      steps: [item.steps.map((step, stepIndex) => `${stepIndex + 1}、${step}`).join("<br>")],
    })),
  },
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
assert.equal(worksheet.getCell("I7").value, "1、输入有效查询条件\n2、点击【查询】按钮\n3、查看结果列表");
assert.equal(worksheet.getCell("I7").alignment.wrapText, true);
assert.equal(worksheet.getCell("G8").value, "空条件查询");
assert.equal(worksheet.getCell("E9").value, "历史页面");
assert.deepEqual([7, 8, 9].map(row => worksheet.getCell(`B${row}`).value), [1, 2, 3]);
assert.equal(worksheet.getCell("K7").value, null);
assert(Object.keys(worksheet.dataValidations.model).length >= 3, "模板数据验证应保留");
console.log(`测试用例工作簿验证通过: ${outputPath}`);
if (!explicitOutputPath) await rm(outputPath, { force: true });
