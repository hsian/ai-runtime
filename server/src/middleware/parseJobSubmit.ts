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

const tapdContextSchema = z.object({
  workspaceId: z.string().min(1).max(32),
  itemType: z.enum(["story", "task", "bug"]).optional(),
  itemId: z.string().min(1).max(64).optional(),
  storyId: z.string().min(1).max(64).optional(),
  url: z.string().url().max(2_048),
  title: z.string().min(1).max(500),
  description: z.string().max(50_000),
  imageCount: z.number().int().min(0).max(100).optional(),
  attachedImageCount: z.number().int().min(0).max(100).optional(),
  attachedImageIndexes: z.array(z.number().int().min(1).max(100)).max(100).optional(),
  status: z.string().max(100).optional(),
  owner: z.string().max(500).optional(),
  fetchedAt: z.string().min(1).max(64),
}).refine((value) => Boolean(value.itemId || value.storyId), {
  message: "TAPD 上下文缺少条目 ID",
});

const submitFieldsSchema = z.object({
  prompt: z.string().min(1, "prompt 不能为空"),
  pageContext: pageContextSchema.optional(),
  tapdContext: tapdContextSchema.optional(),
  submittedBy: z.string().optional(),
  conversationId: z.string().min(1).max(128).optional(),
});

function parseJsonField(raw: unknown): unknown {
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

  const pageContextRaw = parseJsonField(req.body?.pageContext);
  const tapdContextRaw = parseJsonField(req.body?.tapdContext);
  const parsed = submitFieldsSchema.safeParse({
    prompt: req.body?.prompt,
    pageContext: pageContextRaw,
    tapdContext: tapdContextRaw,
    submittedBy: req.body?.submittedBy,
    conversationId: req.body?.conversationId,
  });

  if (!parsed.success) {
    return { error: parsed.error.errors[0]?.message ?? "参数无效" };
  }

  return { data: parsed.data };
}

export function isMultipartSubmit(req: Request): boolean {
  return (req.headers["content-type"] ?? "").includes("multipart/form-data");
}
