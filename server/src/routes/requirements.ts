import { randomUUID } from "crypto";
import { Router } from "express";
import { analyzeRequirement } from "../services/requirementAnalyzer.js";
import {
  finalizeAnalyzeAttachments,
  multerErrorMessage,
  requirementImagesUpload,
  ANALYZE_MAX_IMAGES,
} from "../services/uploadService.js";
import {
  isMultipartAnalyze,
  parseRequirementAnalyzeBody,
} from "../middleware/parseRequirementAnalyze.js";

const MAX_CONTENT_LENGTH = 80_000;

function handleAnalyzeImagesUpload(
  req: import("express").Request,
  res: import("express").Response,
  next: import("express").NextFunction
): void {
  if (!isMultipartAnalyze(req)) {
    next();
    return;
  }

  requirementImagesUpload.array("images", ANALYZE_MAX_IMAGES)(req, res, (err) => {
    if (err) {
      res.status(400).json({ error: multerErrorMessage(err) });
      return;
    }
    next();
  });
}

export const requirementsRouter = Router();

requirementsRouter.post("/analyze", handleAnalyzeImagesUpload, async (req, res) => {
  const parsed = parseRequirementAnalyzeBody(req);
  if (parsed.error || !parsed.data) {
    res.status(400).json({ error: parsed.error ?? "参数无效" });
    return;
  }

  const { title, tapdUrl, rawContent } = parsed.data;
  const trimmedContent =
    rawContent.length > MAX_CONTENT_LENGTH
      ? `${rawContent.slice(0, MAX_CONTENT_LENGTH)}\n\n…（原文过长，已截断）`
      : rawContent;

  const files = isMultipartAnalyze(req)
    ? (req.files as Express.Multer.File[] | undefined)
    : undefined;
  const sessionId = randomUUID();
  const attachments = finalizeAnalyzeAttachments(sessionId, files);

  try {
    const draftPrompt = await analyzeRequirement(title, tapdUrl, trimmedContent, attachments);
    res.json({ draftPrompt, imageCount: attachments.length });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
