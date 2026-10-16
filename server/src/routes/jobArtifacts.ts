import { Router } from "express";
import { existsSync } from "node:fs";
import { getAuthorizedJob } from "./jobAccess.js";
import { getJob, updateJob } from "../services/jobStore.js";
import { toPublicJob } from "../services/publicJob.js";
import { appendJobEvent } from "../services/jobEvents.js";
import { jobQueue } from "../services/jobQueue.js";
import { getProject } from "../services/projectRegistry.js";
import { getProjectGitService } from "../services/projectRuntime.js";
import { generateMiniProgramPreview, getMiniProgramPreviewPath, uploadMiniProgramCode } from "../services/miniProgramPreviewService.js";
import { logOperation } from "../services/operationLog.js";

function getPublicJob(jobId: string) {
  const job = getJob(jobId);
  return job ? toPublicJob(job) : undefined;
}

export const jobArtifactsRouter = Router();

jobArtifactsRouter.post("/:jobId/mini-program-preview", async (req, res) => {
  const jobId = req.params.jobId;
  const job = getAuthorizedJob(req, res);
  if (!job) return;
  const project = getProject(job.projectId);
  if (project.type !== "wechat-mini-program" || !project.miniProgram) {
    res.status(400).json({ error: "当前任务不属于小程序项目" });
    return;
  }
  if (job.status !== "completed" || !job.mergedToDefaultBranch || !(job.sourceCommitSha || job.commitSha)) {
    res.status(400).json({ error: "代码合并到默认分支后才能生成体验版二维码" });
    return;
  }
  try {
    appendJobEvent(jobId, { type: "stage", phase: "mini_program_preview", text: "正在通过微信 CI 生成体验版二维码..." });
    let previewCommitSha = "";
    const { done } = jobQueue.enqueueAndWait(jobId, async () => {
      const result = await generateMiniProgramPreview(job.projectId, jobId, job.implementationSummary || job.prompt, job.sourceCommitSha || job.commitSha || jobId);
      previewCommitSha = result.commitSha;
    });
    await done;
    const createdAt = new Date().toISOString();
    const previewUrl = `/api/jobs/${encodeURIComponent(jobId)}/mini-program-preview`;
    updateJob(jobId, { miniProgramPreviewUrl: previewUrl, miniProgramPreviewCreatedAt: createdAt, miniProgramPreviewCommitSha: previewCommitSha });
    appendJobEvent(jobId, { type: "stage", phase: "mini_program_preview_done", text: "体验版二维码已生成" });
    res.json({ ok: true, previewUrl, createdAt, job: getPublicJob(jobId) });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    appendJobEvent(jobId, { type: "error", phase: "mini_program_preview_failed", text: `体验版二维码生成失败：${error}`, message: error });
    res.status(400).json({ error });
  }
});

jobArtifactsRouter.post("/:jobId/mini-program-upload", async (req, res) => {
  const jobId = req.params.jobId;
  const job = getAuthorizedJob(req, res);
  if (!job) return;
  const project = getProject(job.projectId);
  if (project.type !== "wechat-mini-program" || !project.miniProgram) {
    res.status(400).json({ error: "当前任务不属于小程序项目" });
    return;
  }
  if (job.status !== "completed" || !job.mergedToDefaultBranch || job.revertedFromDefaultAt) {
    res.status(400).json({ error: "代码合并到默认分支后才能上传小程序代码" });
    return;
  }
  const version = typeof req.body?.version === "string" ? req.body.version.trim() : "";
  const description = typeof req.body?.description === "string" ? req.body.description.trim() : "";
  if (!version || version.length > 64) {
    res.status(400).json({ error: "请填写 1-64 个字符的上传版本号" });
    return;
  }
  try {
    logOperation({ action: "mini_program_upload", status: "started", jobId, ownerId: job.ownerId, targetBranch: project.defaultBranch, message: version });
    appendJobEvent(jobId, { type: "stage", phase: "mini_program_upload", text: `正在上传小程序开发版本 ${version}...` });
    const { done } = jobQueue.enqueueAndWait(jobId, async () => {
      await uploadMiniProgramCode(job.projectId, version, description || job.prompt);
    });
    await done;
    const uploadedAt = new Date().toISOString();
    updateJob(jobId, { miniProgramUploadVersion: version, miniProgramUploadDescription: description || job.prompt, miniProgramUploadedAt: uploadedAt });
    logOperation({ action: "mini_program_upload", status: "success", jobId, ownerId: job.ownerId, targetBranch: project.defaultBranch, message: version });
    appendJobEvent(jobId, { type: "stage", phase: "mini_program_upload_done", text: `小程序开发版本 ${version} 已上传` });
    res.json({ ok: true, uploadedAt, job: getPublicJob(jobId) });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logOperation({ action: "mini_program_upload", status: "failed", jobId, ownerId: job.ownerId, targetBranch: project.defaultBranch, error });
    appendJobEvent(jobId, { type: "error", phase: "mini_program_upload_failed", text: `小程序代码上传失败：${error}`, message: error });
    res.status(400).json({ error });
  }
});

jobArtifactsRouter.get("/:jobId/mini-program-preview", (req, res) => {
  const job = getAuthorizedJob(req, res);
  if (!job) return;
  const outputPath = getMiniProgramPreviewPath(job.jobId);
  if (!job.miniProgramPreviewUrl || !existsSync(outputPath)) {
    res.status(404).json({ error: "体验版二维码尚未生成" });
    return;
  }
  res.setHeader("Cache-Control", "private, no-store");
  res.type("png");
  res.sendFile(outputPath);
});

jobArtifactsRouter.get("/:jobId/diff", async (req, res) => {
  const job = getAuthorizedJob(req, res);
  if (!job) return;

  const commitSha = job.sourceCommitSha || job.commitSha;
  if (!commitSha) {
    res.status(404).json({ error: "当前任务没有可查看的代码改动" });
    return;
  }

  const filePath = typeof req.query.file === "string" ? req.query.file.trim() : undefined;
  try {
    const gitService = getProjectGitService(job.projectId);
    const diff = await gitService.getCommitDiff(commitSha, filePath || undefined, job.workbenchSession && job.worktreePath ? job.workbenchBaseCommitSha : undefined);
    res.setHeader("Cache-Control", "private, no-store");
    res.json(diff);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

jobArtifactsRouter.get("/:jobId/attachments/:index", (req, res) => {
  const job = getAuthorizedJob(req, res);
  if (!job) return;
  const index = Number(req.params.index);
  const attachment = Number.isInteger(index) && index >= 0 ? job.attachments?.[index] : undefined;
  if (!attachment) {
    res.status(404).json({ error: "图片不存在" });
    return;
  }
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(attachment.name)}`);
  res.type(attachment.mime);
  res.sendFile(attachment.path);
});

