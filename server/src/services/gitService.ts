import { mkdir } from "fs/promises";
import { resolve } from "path";
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

function formatMergeError(err: unknown, sourceBranch: string, targetBranch: string): Error {
  const message = err instanceof Error ? err.message : String(err);
  const conflictMatch = message.match(/CONFLICTS:\s*(.+)$/s);
  if (!conflictMatch) return err instanceof Error ? err : new Error(message);

  const files = conflictMatch[1]
    .split(",")
    .map((item) => item.trim().replace(/:content$/, ""))
    .filter(Boolean);
  const fileText = files.length > 0 ? files.join(", ") : conflictMatch[1].trim();
  return new Error(`合并冲突：${sourceBranch} 无法自动合并到 ${targetBranch}。冲突文件：${fileText}`);
}

function formatCherryPickError(err: unknown, commitSha: string, targetBranch: string): Error {
  const message = err instanceof Error ? err.message : String(err);
  const conflictMatch = message.match(/CONFLICTS:\s*(.+)$/s);
  if (!conflictMatch) return err instanceof Error ? err : new Error(message);

  const files = conflictMatch[1]
    .split(",")
    .map((item) => item.trim().replace(/:content$/, ""))
    .filter(Boolean);
  const fileText = files.length > 0 ? files.join(", ") : conflictMatch[1].trim();
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

  async pushFeatureBranch(branchName: string): Promise<void> {
    const git = await this.getGit();
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

  async mergeIntoDefaultBranch(branchName: string, mergeMessage: string): Promise<string> {
    return this.mergeIntoBranch(branchName, config.GIT_DEFAULT_BRANCH, mergeMessage);
  }

  async mergeIntoBranch(sourceBranch: string, targetBranch: string, mergeMessage: string): Promise<string> {
    const git = await this.getGit();

    await this.checkoutRemoteBranch(targetBranch);

    const mergeArgs = [
      "--no-ff",
      "-m",
      mergeMessage,
      ...(config.GIT_SKIP_HOOKS ? ["--no-verify"] : []),
      sourceBranch,
    ];

    try {
      await git.merge(mergeArgs);
    } catch (err) {
      try {
        await git.merge(["--abort"]);
      } catch {
        // ignore abort errors
      }
      throw formatMergeError(err, sourceBranch, targetBranch);
    }

    if (config.AUTO_PUSH) {
      await git.push("origin", targetBranch);
    }

    const log = await git.log({ maxCount: 1 });
    return log.latest?.hash ?? "";
  }

  async cherryPickCommitIntoBranch(commitSha: string, targetBranch: string): Promise<string> {
    const git = await this.getGit();

    await this.checkoutRemoteBranch(targetBranch);

    try {
      await git.raw(["cherry-pick", "-x", commitSha]);
    } catch (err) {
      try {
        await git.raw(["cherry-pick", "--abort"]);
      } catch {
        // ignore abort errors
      }
      throw formatCherryPickError(err, commitSha, targetBranch);
    }

    if (config.AUTO_PUSH) {
      await git.push("origin", targetBranch);
    }

    const log = await git.log({ maxCount: 1 });
    return log.latest?.hash ?? "";
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

  async listChangedFilesAgainstDefault(branchName: string): Promise<string[]> {
    const git = await this.getGit();
    const output = await git.diff(["--name-only", `${config.GIT_DEFAULT_BRANCH}...${branchName}`]);
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
