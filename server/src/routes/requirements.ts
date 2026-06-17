import { Router } from "express";
import { z } from "zod";
import { analyzeRequirement } from "../services/requirementAnalyzer.js";

const analyzeSchema = z.object({
  title: z.string().min(1, "title 不能为空"),
  tapdUrl: z.string().min(1, "tapdUrl 不能为空"),
  rawContent: z.string().min(1, "rawContent 不能为空"),
});

const MAX_CONTENT_LENGTH = 80_000;

export const requirementsRouter = Router();

requirementsRouter.post("/analyze", async (req, res) => {
  const parsed = analyzeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.errors[0]?.message ?? "参数无效" });
    return;
  }

  const { title, tapdUrl, rawContent } = parsed.data;
  const trimmedContent =
    rawContent.length > MAX_CONTENT_LENGTH
      ? `${rawContent.slice(0, MAX_CONTENT_LENGTH)}\n\n…（原文过长，已截断）`
      : rawContent;

  try {
    const draftPrompt = await analyzeRequirement(title, tapdUrl, trimmedContent);
    res.json({ draftPrompt });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
