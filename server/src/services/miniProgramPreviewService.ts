import { spawn } from "child_process";
import { createHash } from "crypto";
import { existsSync, mkdirSync } from "fs";
import { readFile, rm, writeFile } from "fs/promises";
import { relative, resolve } from "path";

import { getProject } from "./projectRegistry.js";
import { getProjectGitService } from "./projectRuntime.js";

const previewOutputDir = resolve(process.cwd(), "data", "miniprogram-previews");
const npmPreparationPromises = new Map<string, Promise<void>>();
type MiniProgramCiModule = typeof import("miniprogram-ci");
type MiniProgramCiProject = Parameters<MiniProgramCiModule["packNpm"]>[0];

async function runCommand(command: string, args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, shell: false });
    const output: Buffer[] = [];
    const collect = (chunk: Buffer) => {
      output.push(chunk);
      if (output.reduce((total, item) => total + item.length, 0) > 20_000) output.shift();
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.once("error", (error) => reject(new Error(`无法启动 ${command}：${error.message}`)));
    child.once("exit", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      const detail = Buffer.concat(output).toString("utf8").trim();
      reject(new Error(`${command} ${args.join(" ")} 执行失败${detail ? `：${detail}` : ""}`));
    });
  });
}

async function dependencyFingerprint(projectPath: string): Promise<string> {
  const files = ["package.json", "package-lock.json"];
  const hash = createHash("sha256");
  for (const file of files) {
    const filePath = resolve(projectPath, file);
    if (existsSync(filePath)) hash.update(await readFile(filePath));
  }
  return hash.digest("hex");
}

async function prepareMiniProgramNpm(
  projectPath: string,
  miniprogramCi: Pick<MiniProgramCiModule, "packNpm">,
  ciProject: MiniProgramCiProject
): Promise<void> {
  const current = npmPreparationPromises.get(projectPath);
  if (current) return current;

  const preparation = (async () => {
    const packageJsonPath = resolve(projectPath, "package.json");
    if (!existsSync(packageJsonPath)) return;

    const fingerprint = await dependencyFingerprint(projectPath);
    const markerPath = resolve(projectPath, "node_modules", ".ai-runtime-miniprogram-npm.json");
    const marker = existsSync(markerPath)
      ? await readFile(markerPath, "utf8").then((value) => JSON.parse(value) as { fingerprint?: string }).catch(() => undefined)
      : undefined;
    if (marker?.fingerprint === fingerprint && existsSync(resolve(projectPath, "miniprogram_npm"))) return;

    const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
    const installArgs = existsSync(resolve(projectPath, "package-lock.json"))
      ? ["ci", "--no-audit", "--no-fund"]
      : ["install", "--no-audit", "--no-fund"];
    await runCommand(npmCommand, installArgs, projectPath).catch((error) => {
      throw new Error(`小程序 npm 依赖安装失败：${error instanceof Error ? error.message : String(error)}`);
    });
    ciProject.updateFiles();
    await miniprogramCi.packNpm(ciProject).catch((error: unknown) => {
      throw new Error(`小程序 npm 构建失败：${error instanceof Error ? error.message : String(error)}`);
    });
    await writeFile(markerPath, JSON.stringify({ fingerprint, preparedAt: new Date().toISOString() }), "utf8");
  })().finally(() => npmPreparationPromises.delete(projectPath));

  npmPreparationPromises.set(projectPath, preparation);
  return preparation;
}

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
  await prepareMiniProgramNpm(projectPath, miniprogramCi, ciProject);
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
  await prepareMiniProgramNpm(projectPath, miniprogramCi, ciProject);
  await miniprogramCi.upload({
    project: ciProject,
    version,
    desc: description.slice(0, 100),
    robot: miniProgram.robot,
    setting: { useProjectConfig: true },
  });
  return commitSha;
}
