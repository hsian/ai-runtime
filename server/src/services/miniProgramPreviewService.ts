import { existsSync, mkdirSync } from "fs";
import { rm } from "fs/promises";
import { relative, resolve } from "path";

import { getProject } from "./projectRegistry.js";
import { getProjectGitService } from "./projectRuntime.js";

const previewOutputDir = resolve(process.cwd(), "data", "miniprogram-previews");

function assertInside(parent: string, child: string): void {
  const pathFromParent = relative(parent, child);
  if (pathFromParent.startsWith("..") || resolve(parent, pathFromParent) !== child) {
    throw new Error("小程序项目根目录必须位于项目仓库内");
  }
}

export function getMiniProgramPreviewPath(jobId: string): string {
  return resolve(previewOutputDir, `${jobId}.png`);
}

export async function deleteMiniProgramPreview(jobId: string): Promise<void> {
  await rm(getMiniProgramPreviewPath(jobId), { force: true });
}

export async function generateMiniProgramPreview(
  projectId: string,
  jobId: string,
  description: string,
  version: string
): Promise<{ outputPath: string; commitSha: string }> {
  const projectProfile = getProject(projectId);
  const miniProgram = projectProfile.miniProgram;
  if (projectProfile.type !== "wechat-mini-program" || !miniProgram) {
    throw new Error("当前项目不是已配置的小程序项目");
  }

  const privateKeyPath = process.env[miniProgram.privateKeyPathEnv]?.trim();
  if (!privateKeyPath) {
    throw new Error(`尚未配置微信小程序上传密钥路径，请在服务端 .env 设置 ${miniProgram.privateKeyPathEnv}`);
  }
  if (!existsSync(privateKeyPath)) {
    throw new Error(`微信小程序上传密钥文件不存在，请检查 ${miniProgram.privateKeyPathEnv}`);
  }

  const gitService = getProjectGitService(projectId);
  await gitService.prepareBaseBranch();
  const repoPath = resolve(gitService.getRepoPath());
  const commitSha = await gitService.getHeadCommit();
  const projectPath = resolve(repoPath, miniProgram.projectRoot);
  assertInside(repoPath, projectPath);
  if (!existsSync(resolve(projectPath, "project.config.json"))) {
    throw new Error(`未在 ${miniProgram.projectRoot} 找到 project.config.json`);
  }

  mkdirSync(previewOutputDir, { recursive: true });
  const outputPath = getMiniProgramPreviewPath(jobId);
  const { default: miniprogramCi } = await import("miniprogram-ci");
  const { Project, preview } = miniprogramCi;
  const ciProject = new Project({
    appid: miniProgram.appId,
    type: "miniProgram",
    projectPath,
    privateKeyPath,
    ignores: ["node_modules/**/*"],
  });
  await preview({
    project: ciProject,
    version: version.slice(0, 20),
    desc: description.slice(0, 100),
    robot: miniProgram.robot,
    setting: { useProjectConfig: true },
    qrcodeFormat: "image",
    qrcodeOutputDest: outputPath,
  });
  if (!existsSync(outputPath)) throw new Error("微信 CI 未生成体验版二维码文件");
  return { outputPath, commitSha };
}

export async function uploadMiniProgramCode(
  projectId: string,
  version: string,
  description: string
): Promise<string> {
  const projectProfile = getProject(projectId);
  const miniProgram = projectProfile.miniProgram;
  if (projectProfile.type !== "wechat-mini-program" || !miniProgram) {
    throw new Error("当前项目不是已配置的小程序项目");
  }
  const privateKeyPath = process.env[miniProgram.privateKeyPathEnv]?.trim();
  if (!privateKeyPath || !existsSync(privateKeyPath)) {
    throw new Error(`微信小程序上传密钥不可用，请检查 ${miniProgram.privateKeyPathEnv}`);
  }

  const gitService = getProjectGitService(projectId);
  await gitService.prepareBaseBranch();
  const commitSha = await gitService.getHeadCommit();
  const repoPath = resolve(gitService.getRepoPath());
  const projectPath = resolve(repoPath, miniProgram.projectRoot);
  assertInside(repoPath, projectPath);
  if (!existsSync(resolve(projectPath, "project.config.json"))) {
    throw new Error(`未在 ${miniProgram.projectRoot} 找到 project.config.json`);
  }

  const { default: miniprogramCi } = await import("miniprogram-ci");
  const ciProject = new miniprogramCi.Project({
    appid: miniProgram.appId,
    type: "miniProgram",
    projectPath,
    privateKeyPath,
    ignores: ["node_modules/**/*"],
  });
  await miniprogramCi.upload({
    project: ciProject,
    version,
    desc: description.slice(0, 100),
    robot: miniProgram.robot,
    setting: { useProjectConfig: true },
  });
  return commitSha;
}
