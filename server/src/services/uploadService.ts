import { mkdirSync, renameSync } from "fs";
import { copyFile, mkdir } from "fs/promises";
import { extname, join, resolve } from "path";
import type { Express } from "express";
import multer from "multer";
import { config } from "../config.js";
import type { JobAttachment } from "../types.js";

const TMP_DIR = join(resolve(config.UPLOAD_DIR), "_tmp");

mkdirSync(TMP_DIR, { recursive: true });

const IMAGE_MIME = /^image\/(jpeg|jpg|png|webp|gif)$/i;

export const jobImagesUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      cb(null, TMP_DIR);
    },
    filename: (_req, file, cb) => {
      const ext = extname(file.originalname) || ".webp";
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
    },
  }),
  limits: {
    fileSize: config.UPLOAD_MAX_BYTES,
    files: config.UPLOAD_MAX_COUNT,
  },
  fileFilter: (_req, file, cb) => {
    if (IMAGE_MIME.test(file.mimetype)) {
      cb(null, true);
      return;
    }
    cb(new Error("仅支持 JPEG、PNG、WebP、GIF 图片"));
  },
});

export const ANALYZE_MAX_IMAGES = 8;

export const requirementImagesUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      cb(null, TMP_DIR);
    },
    filename: (_req, file, cb) => {
      const ext = extname(file.originalname) || ".webp";
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
    },
  }),
  limits: {
    fileSize: config.UPLOAD_MAX_BYTES,
    files: ANALYZE_MAX_IMAGES,
  },
  fileFilter: (_req, file, cb) => {
    if (IMAGE_MIME.test(file.mimetype)) {
      cb(null, true);
      return;
    }
    cb(new Error("仅支持 JPEG、PNG、WebP、GIF 图片"));
  },
});

export function finalizeAnalyzeAttachments(
  sessionId: string,
  files: Express.Multer.File[] | undefined
): JobAttachment[] {
  return finalizeJobAttachments(`analyze/${sessionId}`, files);
}

export function finalizeJobAttachments(
  jobId: string,
  files: Express.Multer.File[] | undefined
): JobAttachment[] {
  if (!files?.length) return [];

  const uploadRoot = resolve(config.UPLOAD_DIR);
  const jobDir = join(uploadRoot, jobId);
  mkdirSync(jobDir, { recursive: true });

  return files.map((file, index) => {
    const ext = extname(file.originalname) || extname(file.filename) || ".webp";
    const destPath = join(jobDir, `${index}${ext}`);
    renameSync(file.path, destPath);
    return {
      name: file.originalname || `screenshot-${index + 1}${ext}`,
      path: resolve(destPath),
      mime: file.mimetype,
      sizeBytes: file.size,
    };
  });
}

/** 将截图复制到 Git 工作区内，供 Claude Code（cwd=仓库根目录）读取 */
export async function stageAttachmentsForAgent(
  attachments: JobAttachment[] | undefined,
  repoPath: string,
  jobId: string
): Promise<JobAttachment[] | undefined> {
  if (!attachments?.length) return undefined;

  const agentDir = resolve(repoPath, ".ai-runtime", "uploads", jobId);
  await mkdir(agentDir, { recursive: true });

  const staged: JobAttachment[] = [];
  for (const [index, attachment] of attachments.entries()) {
    const srcPath = resolve(attachment.path);
    const ext = extname(attachment.path) || ".webp";
    const destPath = resolve(agentDir, `${index}${ext}`);
    await copyFile(srcPath, destPath);
    staged.push({ ...attachment, path: destPath });
  }

  return staged;
}

export function multerErrorMessage(err: unknown): string {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return `单张图片不能超过 ${Math.round(config.UPLOAD_MAX_BYTES / 1024)}KB`;
    }
    if (err.code === "LIMIT_FILE_COUNT") {
      return `最多上传 ${config.UPLOAD_MAX_COUNT} 张图片`;
    }
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
