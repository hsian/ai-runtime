import { randomUUID } from "crypto";
import { Router } from "express";
import { RequirementPolishAbortedError } from "../services/requirementTextPolisher.js";
import { analyzeRequirement } from "../services/requirementAnalyzer.js";
import {
  appendAnalyzeEvent,
  cancelAnalyzeSession,
  createAnalyzeSession,
  getAnalyzeEvents,
  getAnalyzeSession,
  subscribeAnalyzeEvents,
  updateAnalyzeSession,
} from "../services/analyzeSession.js";
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
import type { JobAttachment } from "../types.js";

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

async function runAnalyzeSession(
  sessionId: string,
  title: string,
  tapdUrl: string,
  trimmedContent: string,
  attachments: JobAttachment[]
): Promise<void> {
  try {
    appendAnalyzeEvent(sessionId, {
      type: "stage",
      phase: "prepare",
      text: "正在准备整理…",
    });

    if (attachments.length > 0) {
      appendAnalyzeEvent(sessionId, {
        type: "stage",
        phase: "attachments",
        text: `已接收 ${attachments.length} 张配图`,
      });
    }

    const charLabel =
      trimmedContent.length >= 1000
        ? `约 ${(trimmedContent.length / 1000).toFixed(1)}k 字`
        : `约 ${trimmedContent.length} 字`;
    appendAnalyzeEvent(sessionId, {
      type: "stage",
      phase: "agent",
      text: `AI 正在整理需求文字（${charLabel}）…`,
    });
    updateAnalyzeSession(sessionId, { message: `正在整理需求文字（${charLabel}）…` });

    const keepalive = setInterval(() => {
      const session = getAnalyzeSession(sessionId);
      if (!session || session.status !== "running") return;
      const elapsedSec = Math.floor((Date.now() - Date.parse(session.createdAt)) / 1000);
      const label =
        elapsedSec >= 60
          ? `仍在整理文字（已运行 ${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s）…`
          : `仍在整理文字（已运行 ${elapsedSec}s）…`;
      updateAnalyzeSession(sessionId, { message: label });
    }, 15_000);

    try {
      let streamedText = false;
      const draftPrompt = await analyzeRequirement(title, tapdUrl, trimmedContent, attachments, {
        sessionId,
        onEvent: (event) => {
          if (getAnalyzeSession(sessionId)?.status === "cancelled") return;

          if (event.type === "agent_text" && event.delta) {
            streamedText = true;
            appendAnalyzeEvent(sessionId, { type: "agent_text", delta: event.delta });
          }
        },
      });

      if (getAnalyzeSession(sessionId)?.status === "cancelled") return;

      if (!streamedText && draftPrompt.trim()) {
        appendAnalyzeEvent(sessionId, { type: "agent_text", delta: draftPrompt });
      }

      updateAnalyzeSession(sessionId, {
        status: "completed",
        draftPrompt,
        message: "整理完成",
      });
      appendAnalyzeEvent(sessionId, {
        type: "done",
        text: "整理完成",
        draftPrompt,
        message: "整理完成",
      });
    } finally {
      clearInterval(keepalive);
    }
  } catch (err) {
    if (err instanceof RequirementPolishAbortedError || getAnalyzeSession(sessionId)?.status === "cancelled") {
      return;
    }

    const message = err instanceof Error ? err.message : String(err);
    updateAnalyzeSession(sessionId, { status: "failed", error: message, message });
    appendAnalyzeEvent(sessionId, { type: "error", text: message, message });
  }
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
  createAnalyzeSession(attachments.length, sessionId);

  appendAnalyzeEvent(sessionId, {
    type: "stage",
    phase: "queued",
    text: "分析任务已创建，正在启动…",
  });

  void runAnalyzeSession(sessionId, title, tapdUrl, trimmedContent, attachments);

  res.status(202).json({
    sessionId,
    status: "running",
    imageCount: attachments.length,
    message: "分析已开始",
  });
});

requirementsRouter.get("/analyze/:sessionId/stream", (req, res) => {
  const sessionId = req.params.sessionId;
  const session = getAnalyzeSession(sessionId);
  if (!session) {
    res.status(404).json({ error: "分析任务不存在" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const writeEvent = (event: unknown): void => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  for (const event of getAnalyzeEvents(sessionId)) {
    writeEvent(event);
  }

  const unsubscribe = subscribeAnalyzeEvents(sessionId, (event) => {
    writeEvent(event);
    if (event.type === "done" || event.type === "cancelled" || event.type === "error") {
      res.write("event: close\ndata: {}\n\n");
    }
  });

  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, 25_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

requirementsRouter.post("/analyze/:sessionId/cancel", (req, res) => {
  const sessionId = req.params.sessionId;
  const session = getAnalyzeSession(sessionId);
  if (!session) {
    res.status(404).json({ error: "分析任务不存在" });
    return;
  }

  if (session.status === "completed" || session.status === "failed" || session.status === "cancelled") {
    res.status(400).json({ error: `当前状态不可取消: ${session.status}` });
    return;
  }

  cancelAnalyzeSession(sessionId);
  res.json({ ok: true, status: "cancelled" });
});

requirementsRouter.get("/analyze/:sessionId/events", (req, res) => {
  const session = getAnalyzeSession(req.params.sessionId);
  if (!session) {
    res.status(404).json({ error: "分析任务不存在" });
    return;
  }

  res.json({ events: getAnalyzeEvents(session.sessionId) });
});

requirementsRouter.get("/analyze/:sessionId", (req, res) => {
  const session = getAnalyzeSession(req.params.sessionId);
  if (!session) {
    res.status(404).json({ error: "分析任务不存在" });
    return;
  }

  res.json({
    sessionId: session.sessionId,
    status: session.status,
    message: session.message,
    draftPrompt: session.draftPrompt,
    imageCount: session.imageCount,
    error: session.error,
  });
});
