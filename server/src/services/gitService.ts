import { cp, mkdir, rm, stat } from "fs/promises";
import { randomUUID } from "crypto";
import { dirname, resolve } from "path";
import { simpleGit, type SimpleGit } from "simple-git";
import { config, getAuthenticatedRepoUrl } from "../config.js";

interface MergeRequestPayload {
  sourceBranch: string;
  title: string;
  description: string;
}

interface MergeRequestResult {
  url: string;
}

export class GitMergeConflictError extends Error {
  constructor(
    message: string,
    readonly files: string[],
    readonly sourceBranch: string,
    readonly targetBranch: string
  ) {
    super(message);
    this.name = "GitMergeConflictError";
  }
}

export class GitRemoteUnavailableError extends Error {
  constructor(
    message: string,
    readonly operation: "fetch" | "push",
    readonly targetBranch: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "GitRemoteUnavailableError";
  }
}

export interface GitConflictContext {
  operation: "merge" | "cherry-pick";
  worktreePath: string;
  files: string[];
  sourceRef: string;
  targetBranch: string;
}

export type GitConflictResolver = (context: GitConflictContext) => Promise<void>;

function getRepoPathFromUrl(repoUrl: string): { url: URL; path: string } {
  const url = new URL(repoUrl);
  const path = decodeURIComponent(url.pathname.replace(/^\/+/, "").replace(/\.git$/, ""));
  if (!path) {
    throw new Error("无法从 GIT_REPO_URL 解析仓库路径");
  }
  return { url, path };
}

async function readErrorResponse(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  if (!text) return `${res.status} ${res.statusText}`;
  try {
    const parsed = JSON.parse(text) as { message?: unknown; error?: unknown };
    const message = parsed.message ?? parsed.error;
    if (typeof message === "string") return message;
  } catch {
    // Fall back to raw body below.
  }
  return text;
}

function formatMergeError(
  err: unknown,
  sourceBranch: string,
  targetBranch: string,
  detectedFiles: string[] = []
): Error {
  const message = err instanceof Error ? err.message : String(err);
  const conflictMatch = message.match(/CONFLICTS:\s*(.+)$/s);
  const files = detectedFiles.length > 0
    ? detectedFiles
    : conflictMatch?.[1]
      .split(",")
      .map((item) => item.trim().replace(/:content$/, ""))
      .filter(Boolean) ?? [];
  if (files.length === 0) return err instanceof Error ? err : new Error(message);

  const fileText = files.join(", ");
  return new GitMergeConflictError(
    `合并冲突：${sourceBranch} 无法自动合并到 ${targetBranch}。冲突文件：${fileText}`,
    files,
    sourceBranch,
    targetBranch
  );
}

function formatCherryPickError(
  err: unknown,
  commitSha: string,
  targetBranch: string,
  detectedFiles: string[] = []
): Error {
  const message = err instanceof Error ? err.message : String(err);
  const conflictMatch = message.match(/CONFLICTS:\s*(.+)$/s);
  const files = detectedFiles.length > 0
    ? detectedFiles
    : conflictMatch?.[1]
      .split(",")
      .map((item) => item.trim().replace(/:content$/, ""))
      .filter(Boolean) ?? [];
  if (files.length === 0) return err instanceof Error ? err : new Error(message);

  const fileText = files.join(", ");
  return new Error(`合并冲突：提交 ${commitSha} 无法自动应用到 ${targetBranch}。冲突文件：${fileText}`);
}

function formatRevertError(err: unknown, commitSha: string, targetBranch: string): Error {
  const message = err instanceof Error ? err.message : String(err);
  const conflictMatch = message.match(/CONFLICTS:\s*(.+)$/s);
  if (!conflictMatch) return err instanceof Error ? err : new Error(message);

  const files = conflictMatch[1]
    .split(",")
    .map((item) => item.trim().replace(/:content$/, ""))
    .filter(Boolean);
  const fileText = files.length > 0 ? files.join(", ") : conflictMatch[1].trim();
  return new Error(`撤回冲突：提交 ${commitSha} 无法自动从 ${targetBranch} 撤回。冲突文件：${fileText}`);
}

export class GitService {
  private repoPath: string;
  private worktreeRoot: string;
  private git: SimpleGit | null = null;

  constructor() {
    this.repoPath = resolve(config.WORKSPACE_DIR);
    this.worktreeRoot = resolve(config.WORKTREE_DIR);
  }

  private async getGit(): Promise<SimpleGit> {
    await mkdir(this.repoPath, { recursive: true });

    if (!this.git) {
      this.git = simpleGit(this.repoPath);
    }

    const isRepo = await this.git.checkIsRepo();
    if (!isRepo) {
      await simpleGit().clone(getAuthenticatedRepoUrl(), this.repoPath);
      this.git = simpleGit(this.repoPath);
    }

    return this.git;
  }

  private async getGitAt(repoPath: string): Promise<SimpleGit> {
    return simpleGit({
      baseDir: repoPath,
      // 仅用于无人值守执行 cherry-pick --continue，值固定为 "true"，不接收外部输入。
      unsafe: { allowUnsafeEditor: true },
    });
  }

  private getWorktreePath(jobId: string): string {
    return resolve(this.worktreeRoot, jobId.slice(0, 8));
  }

  private assertInsideRepo(repoPath: string, filePath: string): void {
    const repoRoot = resolve(repoPath);
    const resolved = resolve(repoRoot, filePath);
    const relative = resolved.slice(repoRoot.length).replace(/^[\\/]/, "");
    if (!relative || relative.startsWith("..") || resolve(repoRoot, relative) !== resolved) {
      throw new Error(`非法文件路径，拒绝操作: ${filePath}`);
    }
  }

  private async createIntegrationWorktree(targetBranch: string): Promise<string> {
    const git = await this.getGit();
    const safeBranchPart = targetBranch.replace(/[^a-zA-Z0-9._-]+/g, "-") || "branch";
    const worktreePath = resolve(
      this.worktreeRoot,
      "integration",
      `branch-${safeBranchPart}-${randomUUID().slice(0, 8)}`
    );

    try {
      await git.fetch("origin");
    } catch (err) {
      throw new GitRemoteUnavailableError(
        `Git 远程仓库暂时无法访问，获取 ${targetBranch} 失败`,
        "fetch",
        targetBranch,
        { cause: err }
      );
    }
    await mkdir(dirname(worktreePath), { recursive: true });
    try {
      await git.raw([
        "worktree",
        "add",
        "--detach",
        worktreePath,
        `origin/${targetBranch}`,
      ]);
    } catch (err) {
      await git.raw(["worktree", "remove", "--force", worktreePath]).catch(() => {});
      await rm(worktreePath, { recursive: true, force: true }).catch(() => {});
      throw err;
    }

    return worktreePath;
  }

  private async removeIntegrationWorktree(worktreePath: string): Promise<void> {
    const git = await this.getGit();
    await git.raw(["worktree", "remove", "--force", worktreePath]).catch(async () => {
      await rm(worktreePath, { recursive: true, force: true }).catch(() => {});
      await git.raw(["worktree", "prune"]).catch(() => {});
    });
  }

  private async listConflictFiles(git: SimpleGit): Promise<string[]> {
    const output = await git.raw(["diff", "--name-only", "--diff-filter=U"]);
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  private async resolveConflict(
    git: SimpleGit,
    context: GitConflictContext,
    resolver: GitConflictResolver
  ): Promise<void> {
    await resolver(context);

    await git.raw(["add", "--all", "--", ...context.files]);

    const unmergedAfterStage = await this.listConflictFiles(git);
    if (unmergedAfterStage.length > 0) {
      throw new Error(`暂存后仍有未解决冲突：${unmergedAfterStage.join(", ")}`);
    }

    await git.raw(["diff", "--cached", "--check"]);
  }

  private async publishIntegrationCommit(
    integrationGit: SimpleGit,
    targetBranch: string
  ): Promise<string> {
    const commitSha = (await integrationGit.revparse(["HEAD"])).trim();
    if (config.AUTO_PUSH) {
      try {
        await integrationGit.push("origin", `HEAD:${targetBranch}`);
      } catch (err) {
        throw new GitRemoteUnavailableError(
          `Git 远程仓库暂时无法访问，推送 ${targetBranch} 失败`,
          "push",
          targetBranch,
          { cause: err }
        );
      }
    }

    const git = await this.getGit();
    const currentBranch = await this.getCurrentBranch();
    const localBranches = await git.branchLocal();

    // 远端确认成功后才更新本地目标分支，避免 push 失败但预览代码已变化。
    if (currentBranch === targetBranch) {
      await git.merge(["--ff-only", commitSha]);
    } else if (localBranches.all.includes(targetBranch)) {
      await git.raw(["branch", "-f", targetBranch, commitSha]);
    } else {
      await git.raw(["branch", targetBranch, commitSha]);
    }
    return commitSha;
  }

  async createJobWorktree(jobId: string, branchName: string): Promise<string> {
    const git = await this.getGit();
    const worktreePath = this.getWorktreePath(jobId);

    await git.fetch("origin");
    await mkdir(dirname(worktreePath), { recursive: true });
    try {
      await git.raw([
        "worktree",
        "add",
        "-b",
        branchName,
        worktreePath,
        `origin/${config.GIT_DEFAULT_BRANCH}`,
      ]);
    } catch (err) {
      await git.raw(["worktree", "remove", "--force", worktreePath]).catch(() => {});
      await rm(worktreePath, { recursive: true, force: true }).catch(() => {});
      await git.deleteLocalBranch(branchName, true).catch(() => {});
      throw err;
    }

    return worktreePath;
  }

  async removeJobWorktree(worktreePath: string | undefined, branchName?: string): Promise<void> {
    if (!worktreePath) return;
    const git = await this.getGit();

    await git.raw(["worktree", "remove", "--force", worktreePath]).catch(async () => {
      await rm(worktreePath, { recursive: true, force: true }).catch(() => {});
      await git.raw(["worktree", "prune"]).catch(() => {});
    });

    if (branchName) {
      await git.deleteLocalBranch(branchName, true).catch(() => {});
    }
  }

  /** 拉取远程并切到基线分支，供 Plan 和执行阶段同步最新代码 */
  async prepareBaseBranch(): Promise<SimpleGit> {
    const git = await this.getGit();
    await git.fetch("origin");
    await git.checkout(config.GIT_DEFAULT_BRANCH);
    await git.pull("origin", config.GIT_DEFAULT_BRANCH);
    return git;
  }

  async createBranch(branchName: string): Promise<void> {
    const git = await this.prepareBaseBranch();
    await git.checkoutLocalBranch(branchName);
  }

  async getCurrentBranch(repoPath = this.repoPath): Promise<string> {
    const git = repoPath === this.repoPath ? await this.getGit() : await this.getGitAt(repoPath);
    return (await git.revparse(["--abbrev-ref", "HEAD"])).trim();
  }

  async commitAndPush(branchName: string, message: string, repoPath = this.repoPath): Promise<string> {
    const git = repoPath === this.repoPath ? await this.getGit() : await this.getGitAt(repoPath);
    const currentBranch = await this.getCurrentBranch(repoPath);

    if (currentBranch !== branchName) {
      throw new Error(`当前分支是 ${currentBranch}，预期在 ${branchName} 上提交`);
    }

    await git.add(".");
    const status = await git.status();
    if (status.files.length === 0) {
      throw new Error("没有文件变更，无需提交");
    }

    const result = await git.commit(message, undefined, {
      "--author": `${config.GIT_AUTHOR_NAME} <${config.GIT_AUTHOR_EMAIL}>`,
      ...(config.GIT_SKIP_HOOKS ? { "--no-verify": null } : {}),
    });

    // feature 分支默认不推送到远端（只在显式开启时推送）
    if (config.AUTO_PUSH && config.PUSH_FEATURE_BRANCH) {
      await git.push("origin", branchName, { "--set-upstream": null });
    }

    return result.commit;
  }

  async pushFeatureBranch(branchName: string, repoPath = this.repoPath): Promise<void> {
    const git = repoPath === this.repoPath ? await this.getGit() : await this.getGitAt(repoPath);
    await git.push("origin", branchName, { "--set-upstream": null });
  }

  async listRemoteBranches(): Promise<string[]> {
    const git = await this.getGit();
    await git.fetch("origin");
    const branches = await git.branch(["-r"]);
    return branches.all
      .map((name) => name.replace(/^origin\//, "").trim())
      .filter((name) => name && name !== "HEAD" && !name.includes(" -> "))
      .sort((a, b) => a.localeCompare(b));
  }

  async createMergeRequest(payload: MergeRequestPayload): Promise<MergeRequestResult> {
    const { url, path } = getRepoPathFromUrl(config.GIT_REPO_URL);

    if (url.hostname.includes("github")) {
      const [owner, repo] = path.split("/");
      if (!owner || !repo) {
        throw new Error("GitHub 仓库地址格式无效，无法创建 Pull Request");
      }
      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
        method: "POST",
        headers: {
          "Accept": "application/vnd.github+json",
          "Authorization": `Bearer ${config.GIT_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
          "User-Agent": "ai-runtime",
        },
        body: JSON.stringify({
          title: payload.title,
          head: payload.sourceBranch,
          base: config.GIT_DEFAULT_BRANCH,
          body: payload.description,
        }),
      });
      const data = (await res.clone().json().catch(() => null)) as { html_url?: string; message?: string } | null;
      if (!res.ok || !data?.html_url) {
        throw new Error(`创建 Pull Request 失败: ${data?.message ?? (await readErrorResponse(res))}`);
      }
      return { url: data.html_url };
    }

    const apiUrl = `${url.origin}/api/v4/projects/${encodeURIComponent(path)}/merge_requests`;
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.GIT_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
        "PRIVATE-TOKEN": config.GIT_ACCESS_TOKEN,
      },
      body: JSON.stringify({
        source_branch: payload.sourceBranch,
        target_branch: config.GIT_DEFAULT_BRANCH,
        title: payload.title,
        description: payload.description,
      }),
    });
    const data = (await res.clone().json().catch(() => null)) as { web_url?: string; message?: unknown } | null;
    if (!res.ok || !data?.web_url) {
      const message = data?.message ? JSON.stringify(data.message) : await readErrorResponse(res);
      throw new Error(`创建 Merge Request 失败: ${message}`);
    }
    return { url: data.web_url };
  }

  async mergeIntoDefaultBranch(
    branchName: string,
    mergeMessage: string,
    conflictResolver?: GitConflictResolver
  ): Promise<string> {
    return this.mergeIntoBranch(
      branchName,
      config.GIT_DEFAULT_BRANCH,
      mergeMessage,
      conflictResolver
    );
  }

  async mergeIntoBranch(
    sourceBranch: string,
    targetBranch: string,
    mergeMessage: string,
    conflictResolver?: GitConflictResolver
  ): Promise<string> {
    const worktreePath = await this.createIntegrationWorktree(targetBranch);
    const git = await this.getGitAt(worktreePath);

    const mergeArgs = [
      "--no-ff",
      "-m",
      mergeMessage,
      ...(config.GIT_SKIP_HOOKS ? ["--no-verify"] : []),
      sourceBranch,
    ];

    try {
      try {
        await git.merge(mergeArgs);
      } catch (err) {
        const files = await this.listConflictFiles(git);
        if (files.length === 0 || !conflictResolver) {
          throw formatMergeError(err, sourceBranch, targetBranch, files);
        }

        try {
          await this.resolveConflict(git, {
            operation: "merge",
            worktreePath,
            files,
            sourceRef: sourceBranch,
            targetBranch,
          }, conflictResolver);
          await git.raw([
            "commit",
            "--no-edit",
            ...(config.GIT_SKIP_HOOKS ? ["--no-verify"] : []),
          ]);
        } catch (resolutionError) {
          const detail = resolutionError instanceof Error
            ? resolutionError.message
            : String(resolutionError);
          throw new GitMergeConflictError(
            `AI 自动解决合并冲突失败：${detail}。冲突文件：${files.join(", ")}`,
            files,
            sourceBranch,
            targetBranch
          );
        }
      }

      return await this.publishIntegrationCommit(git, targetBranch);
    } catch (err) {
      try {
        await git.merge(["--abort"]);
      } catch {
        // ignore abort errors
      }
      throw formatMergeError(err, sourceBranch, targetBranch);
    } finally {
      await this.removeIntegrationWorktree(worktreePath);
    }
  }

  async cherryPickCommitIntoBranch(
    commitSha: string,
    targetBranch: string,
    conflictResolver?: GitConflictResolver
  ): Promise<string> {
    const worktreePath = await this.createIntegrationWorktree(targetBranch);
    const git = await this.getGitAt(worktreePath);

    try {
      try {
        await git.raw(["cherry-pick", "-x", commitSha]);
      } catch (err) {
        const files = await this.listConflictFiles(git);
        if (files.length === 0 || !conflictResolver) {
          throw formatCherryPickError(err, commitSha, targetBranch, files);
        }

        try {
          await this.resolveConflict(git, {
            operation: "cherry-pick",
            worktreePath,
            files,
            sourceRef: commitSha,
            targetBranch,
          }, conflictResolver);
          git.env("GIT_EDITOR", "true");
          await git.raw(["cherry-pick", "--continue"]);
        } catch (resolutionError) {
          const detail = resolutionError instanceof Error
            ? resolutionError.message
            : String(resolutionError);
          throw new Error(
            `AI 自动解决 cherry-pick 冲突失败：${detail}。冲突文件：${files.join(", ")}`
          );
        }
      }

      return await this.publishIntegrationCommit(git, targetBranch);
    } catch (err) {
      try {
        await git.raw(["cherry-pick", "--abort"]);
      } catch {
        // ignore abort errors
      }
      throw formatCherryPickError(err, commitSha, targetBranch);
    } finally {
      await this.removeIntegrationWorktree(worktreePath);
    }
  }

  async revertCommitOnBranch(commitSha: string, targetBranch: string): Promise<string> {
    const git = await this.getGit();

    await this.checkoutRemoteBranch(targetBranch);

    try {
      const parentsLine = (await git.raw(["rev-list", "--parents", "-n", "1", commitSha])).trim();
      const parentCount = Math.max(0, parentsLine.split(/\s+/).length - 1);
      const args = parentCount > 1
        ? ["revert", "-m", "1", "--no-edit", commitSha]
        : ["revert", "--no-edit", commitSha];
      await git.raw(args);
    } catch (err) {
      try {
        await git.raw(["revert", "--abort"]);
      } catch {
        // ignore abort errors
      }
      throw formatRevertError(err, commitSha, targetBranch);
    }

    if (config.AUTO_PUSH) {
      await git.push("origin", targetBranch);
    }

    const log = await git.log({ maxCount: 1 });
    return log.latest?.hash ?? "";
  }

  private async checkoutRemoteBranch(targetBranch: string): Promise<void> {
    const git = await this.getGit();
    await git.fetch("origin");
    const localBranches = await git.branchLocal();
    if (localBranches.all.includes(targetBranch)) {
      await git.checkout(targetBranch);
    } else {
      await git.checkout(["-B", targetBranch, `origin/${targetBranch}`]);
    }
    await git.pull("origin", targetBranch);
  }

  async listChangedFilesAgainstDefault(branchName: string, repoPath = this.repoPath): Promise<string[]> {
    const git = repoPath === this.repoPath ? await this.getGit() : await this.getGitAt(repoPath);
    const output = await git.diff(["--name-only", `origin/${config.GIT_DEFAULT_BRANCH}...${branchName}`]);
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  async restoreBaseBranch(): Promise<void> {
    const git = await this.getGit();
    const current = await this.getCurrentBranch();
    if (current !== config.GIT_DEFAULT_BRANCH) {
      await git.checkout(config.GIT_DEFAULT_BRANCH);
    }
  }

  /** 放弃合并：切回 test 并删除本地 feature 分支，test 保持远端最新 */
  async discardFeatureBranch(branchName: string, worktreePath?: string): Promise<void> {
    const git = await this.getGit();
    const defaultBranch = config.GIT_DEFAULT_BRANCH;

    if (worktreePath) {
      await this.removeJobWorktree(worktreePath, branchName);
      return;
    }

    await git.fetch("origin");
    const current = await this.getCurrentBranch();
    if (current !== defaultBranch) {
      await git.checkout(defaultBranch);
    }
    await git.pull("origin", defaultBranch);

    const branches = await git.branchLocal();
    if (branches.all.includes(branchName)) {
      await git.deleteLocalBranch(branchName, true);
    }
  }

  getRepoPath(): string {
    return this.repoPath;
  }

  async hasUncommittedChanges(repoPath = this.repoPath): Promise<boolean> {
    const git = repoPath === this.repoPath ? await this.getGit() : await this.getGitAt(repoPath);
    const status = await git.status();
    return status.files.length > 0;
  }

  async listUncommittedPaths(repoPath = this.repoPath): Promise<string[]> {
    const git = repoPath === this.repoPath ? await this.getGit() : await this.getGitAt(repoPath);
    const status = await git.status();
    return [...new Set(status.files.map((file) => file.path).filter(Boolean))];
  }

  async copyUncommittedChanges(sourceRepoPath: string, targetRepoPath: string): Promise<string[]> {
    const sourceGit = sourceRepoPath === this.repoPath ? await this.getGit() : await this.getGitAt(sourceRepoPath);
    const status = await sourceGit.status();
    const paths = [...new Set(status.files.map((file) => file.path).filter(Boolean))];

    for (const path of paths) {
      this.assertInsideRepo(sourceRepoPath, path);
      this.assertInsideRepo(targetRepoPath, path);

      const sourcePath = resolve(sourceRepoPath, path);
      const targetPath = resolve(targetRepoPath, path);
      const sourceStat = await stat(sourcePath).catch(() => null);

      if (!sourceStat) {
        await rm(targetPath, { recursive: true, force: true });
        continue;
      }

      await mkdir(dirname(targetPath), { recursive: true });
      await cp(sourcePath, targetPath, { recursive: true, force: true });
    }

    return paths;
  }

  async discardSpecificUncommittedChanges(paths: string[], repoPath = this.repoPath): Promise<void> {
    if (paths.length === 0) return;
    const git = repoPath === this.repoPath ? await this.getGit() : await this.getGitAt(repoPath);

    for (const path of paths) {
      this.assertInsideRepo(repoPath, path);
    }

    await git.raw(["restore", "--staged", "--worktree", "--", ...paths]).catch(() => {});

    const remaining = await git.status();
    const remainingByPath = new Map(remaining.files.map((file) => [file.path, file]));
    for (const path of paths) {
      const file = remainingByPath.get(path) as { index?: string; working_dir?: string } | undefined;
      if (file?.index === "?" || file?.working_dir === "?") {
        await rm(resolve(repoPath, path), { recursive: true, force: true });
      }
    }
  }

  /** 服务重启后：还原工作区、回到基线分支、清理 plugin-fix 分支 */
  async resetWorkspaceAfterRestart(): Promise<void> {
    const git = await this.getGit();
    const defaultBranch = config.GIT_DEFAULT_BRANCH;

    await git.reset(["--hard", "HEAD"]);
    await git.clean("f", ["-d"]);

    await git.fetch("origin").catch(() => {});

    const current = (await git.revparse(["--abbrev-ref", "HEAD"])).trim();
    if (current !== defaultBranch) {
      await git.checkout(defaultBranch);
    }

    await git.pull("origin", defaultBranch).catch((err) => {
      console.warn("[GitService] 拉取基线分支失败:", err instanceof Error ? err.message : err);
    });

    const branches = await git.branchLocal();
    for (const name of branches.all) {
      if (!name.startsWith("plugin-fix/")) continue;
      await git.deleteLocalBranch(name, true).catch(() => {});
    }
  }

  /** 丢弃工作区所有未提交改动（Plan 误改或取消后还原） */
  async discardUncommittedChanges(repoPath = this.repoPath): Promise<string[]> {
    const git = repoPath === this.repoPath ? await this.getGit() : await this.getGitAt(repoPath);
    const status = await git.status();
    const files = [...new Set(status.files.map((f) => f.path))];
    if (files.length === 0) return [];

    await git.reset(["--hard", "HEAD"]);
    await git.clean("f", ["-d"]);
    return files;
  }
}

export const gitService = new GitService();
