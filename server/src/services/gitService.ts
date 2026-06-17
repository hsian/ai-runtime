import { mkdir } from "fs/promises";
import { resolve } from "path";
import { simpleGit, type SimpleGit } from "simple-git";
import { config, getAuthenticatedRepoUrl } from "../config.js";

export class GitService {
  private repoPath: string;
  private git: SimpleGit | null = null;

  constructor() {
    this.repoPath = resolve(config.WORKSPACE_DIR);
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

  /** 拉取远程并切到基线分支，仅在任务开始时调用 */
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

  async getCurrentBranch(): Promise<string> {
    const git = await this.getGit();
    return (await git.revparse(["--abbrev-ref", "HEAD"])).trim();
  }

  async commitAndPush(branchName: string, message: string): Promise<string> {
    const git = await this.getGit();
    const currentBranch = await this.getCurrentBranch();

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

  async mergeIntoDefaultBranch(branchName: string, mergeMessage: string): Promise<string> {
    const git = await this.getGit();

    await git.checkout(config.GIT_DEFAULT_BRANCH);
    await git.pull("origin", config.GIT_DEFAULT_BRANCH);

    const mergeArgs = [
      "--no-ff",
      "-m",
      mergeMessage,
      ...(config.GIT_SKIP_HOOKS ? ["--no-verify"] : []),
      branchName,
    ];

    try {
      await git.merge(mergeArgs);
    } catch (err) {
      try {
        await git.merge(["--abort"]);
      } catch {
        // ignore abort errors
      }
      throw err;
    }

    if (config.AUTO_PUSH) {
      await git.push("origin", config.GIT_DEFAULT_BRANCH);
    }

    const log = await git.log({ maxCount: 1 });
    return log.latest?.hash ?? "";
  }

  async restoreBaseBranch(): Promise<void> {
    const git = await this.getGit();
    const current = await this.getCurrentBranch();
    if (current !== config.GIT_DEFAULT_BRANCH) {
      await git.checkout(config.GIT_DEFAULT_BRANCH);
    }
  }

  /** 放弃合并：切回 test 并删除本地 feature 分支，test 保持远端最新 */
  async discardFeatureBranch(branchName: string): Promise<void> {
    const git = await this.getGit();
    const defaultBranch = config.GIT_DEFAULT_BRANCH;

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

  async hasUncommittedChanges(): Promise<boolean> {
    const git = await this.getGit();
    const status = await git.status();
    return status.files.length > 0;
  }

  /** 丢弃工作区所有未提交改动（Plan 误改或取消后还原） */
  async discardUncommittedChanges(): Promise<string[]> {
    const git = await this.getGit();
    const status = await git.status();
    const files = [...new Set(status.files.map((f) => f.path))];
    if (files.length === 0) return [];

    await git.reset(["--hard", "HEAD"]);
    await git.clean("f", ["-d"]);
    return files;
  }
}

export const gitService = new GitService();
