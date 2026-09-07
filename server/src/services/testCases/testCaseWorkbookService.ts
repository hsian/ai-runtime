import ExcelJS from "exceljs";

import { config } from "../../config.js";
import type { Job, TestCaseDocument } from "../../types.js";

const DATA_START_ROW = 7;
const DATA_END_ROW = 520;

function findCaseWorksheet(workbook: ExcelJS.Workbook): ExcelJS.Worksheet {
  const worksheet = workbook.worksheets.find((sheet) => sheet.getCell("B5").text === "用例编号");
  if (!worksheet) throw new Error("测试用例模板缺少用例工作表");
  return worksheet;
}

function stepsText(steps: string[]): string {
  return steps.map((step, index) => `${index + 1}、${step}`).join("\n");
}

function fillDocument(worksheet: ExcelJS.Worksheet, document: TestCaseDocument): void {
  worksheet.getCell("C1").value = document.moduleName;
  worksheet.getCell("C2").value = document.functionDescription;
  worksheet.getCell("C4").value = "AI";
  worksheet.getCell("E4").value = new Date();
  worksheet.getCell("E4").numFmt = "yyyy-mm-dd";

  for (let rowNumber = DATA_START_ROW; rowNumber <= DATA_END_ROW; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    for (let column = 2; column <= 14; column += 1) row.getCell(column).value = null;
  }

  for (const item of document.cases) {
    const row = worksheet.getRow(DATA_START_ROW + item.caseNumber - 1);
    row.getCell(2).value = item.caseNumber;
    row.getCell(3).value = item.priority;
    row.getCell(4).value = item.levelOneModule;
    row.getCell(5).value = item.levelTwoModule;
    row.getCell(6).value = item.requirementPoint;
    row.getCell(7).value = item.testPoint;
    row.getCell(8).value = item.preconditions;
    row.getCell(9).value = stepsText(item.steps);
    row.getCell(10).value = item.expectedResult;
    row.getCell(11).value = null;
    row.getCell(12).value = null;
    row.getCell(13).value = null;
    row.getCell(14).value = null;
    row.height = Math.max(32, 18 * Math.max(item.steps.length, 2));
  }
}

function addImplementationReference(workbook: ExcelJS.Workbook, document: TestCaseDocument): void {
  const assessment = document.implementationAssessment;
  if (!assessment) return;

  const worksheet = workbook.getWorksheet("实现参考") ?? workbook.addWorksheet("实现参考");
  worksheet.views = [{ showGridLines: false }];
  worksheet.properties.defaultRowHeight = 22;
  worksheet.columns = [
    { width: 3 },
    { width: 18 },
    { width: 24 },
    { width: 24 },
    { width: 24 },
    { width: 24 },
  ];

  worksheet.mergeCells("B1:F1");
  worksheet.getCell("B1").value = "需求实现参考";
  worksheet.getCell("B1").font = { name: "微软雅黑", size: 15, bold: true, color: { argb: "FF245794" } };
  worksheet.getCell("B1").alignment = { vertical: "middle" };
  worksheet.getRow(1).height = 30;

  const sections: Array<{ row: number; label: string; value: string }> = [
    { row: 3, label: "推荐结果", value: assessment.recommendedResult },
    { row: 5, label: "判断说明", value: assessment.summary },
    { row: 7, label: "代码依据", value: assessment.evidence.length ? assessment.evidence.map((item, index) => `${index + 1}、${item}`).join("\n") : "未提供明确代码依据" },
    { row: 9, label: "缺口/待验证", value: assessment.gaps.length ? assessment.gaps.map((item, index) => `${index + 1}、${item}`).join("\n") : "无" },
  ];

  for (const section of sections) {
    worksheet.getCell(section.row, 2).value = section.label;
    worksheet.getCell(section.row, 2).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF245794" } };
    worksheet.getCell(section.row, 2).font = { name: "微软雅黑", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
    worksheet.getCell(section.row, 2).alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    worksheet.mergeCells(section.row, 3, section.row, 6);
    worksheet.getCell(section.row, 3).value = section.value;
    worksheet.getCell(section.row, 3).font = { name: "微软雅黑", size: 10, color: { argb: "FF222222" } };
    worksheet.getCell(section.row, 3).alignment = { horizontal: "left", vertical: "middle", wrapText: true };
    worksheet.getRow(section.row).height = Math.max(30, section.value.split("\n").length * 20);
    for (let column = 2; column <= 6; column += 1) {
      worksheet.getCell(section.row, column).border = {
        top: { style: "thin", color: { argb: "FFD9D9D9" } },
        left: { style: "thin", color: { argb: "FFD9D9D9" } },
        bottom: { style: "thin", color: { argb: "FFD9D9D9" } },
        right: { style: "thin", color: { argb: "FFD9D9D9" } },
      };
    }
  }

  worksheet.mergeCells("B11:F11");
  worksheet.getCell("B11").value = "说明：推荐结果基于当前分支代码静态分析，仅供测试参考；实际结果、状态、测试日期和测试人由测试人员执行验证后填写。";
  worksheet.getCell("B11").font = { name: "微软雅黑", size: 9, italic: true, color: { argb: "FF666666" } };
  worksheet.getCell("B11").alignment = { horizontal: "left", vertical: "middle", wrapText: true };
  worksheet.getRow(11).height = 34;
}

function updateDirectory(workbook: ExcelJS.Workbook, worksheet: ExcelJS.Worksheet, job: Job): void {
  const directory = workbook.getWorksheet("目录");
  if (!directory) return;
  const label = job.tapdContext?.title || job.prompt;
  directory.getCell("B3").value = { text: label.slice(0, 100), hyperlink: `#'${worksheet.name}'!A1` };
  directory.getCell("D3").value = {
    formula: `COUNT('${worksheet.name}'!B:B)`,
    result: job.testCaseDocument?.cases.length ?? 0,
  };
}

export async function buildTestCaseWorkbook(job: Job): Promise<Buffer> {
  if (!job.testCaseDocument) throw new Error("测试用例尚未生成");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(config.TEST_CASE_TEMPLATE_PATH);
  const worksheet = findCaseWorksheet(workbook);
  fillDocument(worksheet, job.testCaseDocument);
  addImplementationReference(workbook, job.testCaseDocument);
  updateDirectory(workbook, worksheet, job);
  const output = await workbook.xlsx.writeBuffer();
  return Buffer.from(output);
}

export function testCaseWorkbookFileName(job: Job): string {
  const base = (job.tapdContext?.title || job.testCaseDocument?.moduleName || "测试用例")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return `${base || "测试用例"}-测试用例.xlsx`;
}
