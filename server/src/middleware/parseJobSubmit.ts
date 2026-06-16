import type { Request } from "express";
import { z } from "zod";
import type { JobRequest } from "../types.js";

const pageContextSchema = z.object({
  url: z.string(),
  title: z.string(),
  selectedText: z.string().optional(),
  selectedSelector: z.string().optional(),
  viewport: z.object({ width: z.number(), height: z.number() }),
});

const submitFieldsSchema = z.object({
  prompt: z.string().min(1, "prompt 不能为空"),
  pageContext: pageContextSchema.optional(),
  submittedBy: z.string().optional(),
});

function parsePageContextField(raw: unknown): unknown {
  if (raw == null || raw === "") return undefined;
  if (typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function parseJobSubmitBody(req: Request): { data?: JobRequest; error?: string } {
  const isMultipart = (req.headers["content-type"] ?? "").includes("multipart/form-data");

  if (!isMultipart) {
    const parsed = submitFieldsSchema.safeParse(req.body);
    if (!parsed.success) {
      return { error: parsed.error.errors[0]?.message ?? "参数无效" };
    }
    return { data: parsed.data };
  }

  const pageContextRaw = parsePageContextField(req.body?.pageContext);
  const parsed = submitFieldsSchema.safeParse({
    prompt: req.body?.prompt,
    pageContext: pageContextRaw,
    submittedBy: req.body?.submittedBy,
  });

  if (!parsed.success) {
    return { error: parsed.error.errors[0]?.message ?? "参数无效" };
  }

  return { data: parsed.data };
}

export function isMultipartSubmit(req: Request): boolean {
  return (req.headers["content-type"] ?? "").includes("multipart/form-data");
}
