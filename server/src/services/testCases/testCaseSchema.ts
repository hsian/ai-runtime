import { z } from "zod";

import type { TestCaseDocument } from "../../types.js";

const nonEmptyText = z.string().trim().min(1).max(5_000);

const prioritySchema = z.preprocess((value) => {
  if (value === "P0" || value === "P1" || value === "high") return "高";
  if (value === "P2" || value === "medium") return "中";
  if (value === "P3" || value === "low") return "低";
  return value;
}, z.enum(["高", "中", "低"]));

const stepsSchema = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  return value
    .split(/\r?\n/)
    .map((item) => item.replace(/^\s*\d+[.、)]\s*/, "").trim())
    .filter(Boolean);
}, z.array(nonEmptyText).min(1).max(30));

const generatedCaseSchema = z.object({
  priority: prioritySchema,
  levelOneModule: nonEmptyText,
  levelTwoModule: nonEmptyText,
  requirementPoint: nonEmptyText,
  testPoint: nonEmptyText,
  preconditions: nonEmptyText,
  steps: stepsSchema,
  expectedResult: nonEmptyText,
});

const textListSchema = z.preprocess((value) => {
  if (value == null || value === "") return [];
  if (typeof value !== "string") return value;
  return value
    .split(/\r?\n|[；;]/)
    .map((item) => item.replace(/^\s*\d+[.、)]\s*/, "").trim())
    .filter(Boolean);
}, z.array(nonEmptyText).max(30));

const implementationAssessmentSchema = z.object({
  recommendedResult: z.enum(["已实现", "部分实现", "未实现", "无法判断"]),
  summary: nonEmptyText,
  evidence: textListSchema,
  gaps: textListSchema,
});

const generatedDocumentSchema = z.object({
  moduleName: nonEmptyText,
  functionDescription: nonEmptyText,
  implementationAssessment: implementationAssessmentSchema,
  cases: z.array(generatedCaseSchema).min(1).max(200),
});

function jsonCandidates(output: string): string[] {
  const trimmed = output.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)?.[1]?.trim();
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  return [trimmed, fenced, firstBrace >= 0 && lastBrace > firstBrace ? trimmed.slice(firstBrace, lastBrace + 1) : undefined]
    .filter((value): value is string => Boolean(value));
}

export function parseTestCaseDocument(output: string): TestCaseDocument {
  let lastError = "未找到有效 JSON";
  for (const candidate of jsonCandidates(output)) {
    try {
      const raw = JSON.parse(candidate) as Record<string, unknown>;
      if (!raw.cases && Array.isArray(raw.testCases)) raw.cases = raw.testCases;
      const parsed = generatedDocumentSchema.safeParse(raw);
      if (!parsed.success) {
        lastError = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("；");
        continue;
      }
      return {
        moduleName: parsed.data.moduleName,
        functionDescription: parsed.data.functionDescription,
        implementationAssessment: parsed.data.implementationAssessment,
        cases: parsed.data.cases.map((item, index) => ({ ...item, caseNumber: index + 1 })),
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`测试用例输出格式无效：${lastError}`);
}
