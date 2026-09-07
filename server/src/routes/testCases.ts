import { existsSync } from "node:fs";

import { Router } from "express";

import { config } from "../config.js";
import { isMultipartSubmit, parseJobSubmitBody } from "../middleware/parseJobSubmit.js";
import { getClientIdentity } from "../services/clientIdentity.js";
import { appendJobEvent } from "../services/jobEvents.js";
import { createJob, getJob, updateJob } from "../services/jobStore.js";
import { logOperation } from "../services/operationLog.js";
import { buildTestCaseWorkbook, testCaseWorkbookFileName } from "../services/testCases/testCaseWorkbookService.js";
import { runTestCaseJob } from "../services/testCases/testCaseJobService.js";
import { finalizeJobAttachments, jobImagesUpload, multerErrorMessage } from "../services/uploadService.js";

function handleImages(
  req: import("express").Request,
  res: import("express").Response,
  next: import("express").NextFunction
): void {
  if (!isMultipartSubmit(req)) {
    next();
    return;
  }
  jobImagesUpload.array("images")(req, res, (error) => {
    if (error) {
      res.status(400).json({ error: multerErrorMessage(error) });
      return;
    }
    next();
  });
}

function authorizedJob(req: import("express").Request, res: import("express").Response) {
  const job = getJob(req.params.jobId);
  const ownerId = getClientIdentity(req).ownerId;
  if (!job || (job.ownerId && job.ownerId !== ownerId)) {
    res.status(404).json({ error: "任务不存在" });
    return undefined;
  }
  return job;
}

export const testCasesRouter = Router();

testCasesRouter.post("/", handleImages, (req, res) => {
  const parsed = parseJobSubmitBody(req);
  if (parsed.error || !parsed.data) {
    res.status(400).json({ error: parsed.error ?? "参数无效" });
    return;
  }

  const identity = getClientIdentity(req);
  const job = createJob({
    ...parsed.data,
    taskMode: "test-case",
    ownerId: identity.ownerId,
    remoteIp: identity.remoteIp,
  });
  const files = isMultipartSubmit(req) ? (req.files as Express.Multer.File[] | undefined) : undefined;
  const attachments = finalizeJobAttachments(job.jobId, files);
  if (attachments.length > 0) updateJob(job.jobId, { attachments });

  appendJobEvent(job.jobId, {
    type: "user",
    text: parsed.data.prompt,
    pageUrl: parsed.data.pageContext?.url,
    attachmentCount: attachments.length || undefined,
  });
  if (attachments.length > 0) {
    appendJobEvent(job.jobId, { type: "stage", phase: "attachments", text: `已接收 ${attachments.length} 张截图` });
  }
  logOperation({
    action: "job_submit",
    status: "success",
    jobId: job.jobId,
    ownerId: job.ownerId,
    mode: "test-case",
    engine: job.agentProvider ?? config.AGENT_PROVIDER,
    attachmentCount: attachments.length,
  });

  void runTestCaseJob(job.jobId);
  res.status(202).json({
    jobId: job.jobId,
    status: "running",
    message: "已进入测试用例模式（只读，不修改代码）",
    jobsAhead: 0,
  });
});

testCasesRouter.get("/:jobId/download", async (req, res) => {
  const job = authorizedJob(req, res);
  if (!job) return;
  if (job.taskMode !== "test-case" || !job.testCaseDocument) {
    res.status(409).json({ error: "测试用例尚未生成" });
    return;
  }
  if (!existsSync(config.TEST_CASE_TEMPLATE_PATH)) {
    res.status(500).json({ error: "测试用例模板不存在" });
    return;
  }

  try {
    const fileName = testCaseWorkbookFileName(job);
    const workbook = await buildTestCaseWorkbook(job);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    res.send(workbook);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Excel 生成失败" });
  }
});
