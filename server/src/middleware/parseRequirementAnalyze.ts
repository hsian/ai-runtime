import type { Request } from "express";
import { z } from "zod";

const analyzeFieldsSchema = z.object({
  title: z.string().min(1, "title 不能为空"),
  tapdUrl: z.string().min(1, "tapdUrl 不能为空"),
  rawContent: z.string().min(1, "rawContent 不能为空"),
});

export interface RequirementAnalyzeBody {
  title: string;
  tapdUrl: string;
  rawContent: string;
}

export function isMultipartAnalyze(req: Request): boolean {
  return (req.headers["content-type"] ?? "").includes("multipart/form-data");
}

export function parseRequirementAnalyzeBody(req: Request): {
  data?: RequirementAnalyzeBody;
  error?: string;
} {
  const parsed = analyzeFieldsSchema.safeParse({
    title: req.body?.title,
    tapdUrl: req.body?.tapdUrl,
    rawContent: req.body?.rawContent,
  });

  if (!parsed.success) {
    return { error: parsed.error.errors[0]?.message ?? "参数无效" };
  }

  return { data: parsed.data };
}
