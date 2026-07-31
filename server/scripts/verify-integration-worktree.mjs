import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, "../data/git-integration-verification");
const remote = join(root, "remote.git");
const seed = join(root, "seed");
const workspace = join(root, "workspace");
const worktrees = join(root, "worktrees");

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });
git(root, "init", "--bare", remote);
git(root, "init", "-b", "main", seed);
git(seed, "config", "user.name", "Integration Test");
git(seed, "config", "user.email", "integration@example.com");
await writeFile(join(seed, "merge.txt"), "base\n");
await writeFile(join(seed, "pick.txt"), "base\n");
git(seed, "add", ".");
git(seed, "commit", "-m", "base");
git(seed, "remote", "add", "origin", remote);
git(seed, "push", "-u", "origin", "main");
git(remote, "symbolic-ref", "HEAD", "refs/heads/main");

git(seed, "checkout", "-b", "feature");
await writeFile(join(seed, "merge.txt"), "feature\n");
git(seed, "commit", "-am", "feature change");
git(seed, "push", "origin", "feature");

git(seed, "checkout", "main");
git(seed, "checkout", "-b", "pick-source");
await writeFile(join(seed, "pick.txt"), "source\n");
git(seed, "commit", "-am", "pick source");
const pickSha = git(seed, "rev-parse", "HEAD");
git(seed, "push", "origin", "pick-source");

git(seed, "checkout", "main");
git(seed, "checkout", "-b", "release");
await writeFile(join(seed, "pick.txt"), "release\n");
git(seed, "commit", "-am", "release change");
git(seed, "push", "origin", "release");
git(seed, "branch", "failure", "release");
git(seed, "push", "origin", "failure");
git(seed, "branch", "push-failure", "release");
git(seed, "push", "origin", "push-failure");

git(seed, "checkout", "main");
await writeFile(join(seed, "merge.txt"), "main\n");
git(seed, "commit", "-am", "main change");
git(seed, "push", "origin", "main");

git(root, "clone", remote, workspace);
git(workspace, "config", "user.name", "Integration Test");
git(workspace, "config", "user.email", "integration@example.com");
git(workspace, "branch", "feature", "origin/feature");

process.env.GIT_REPO_URL = "https://example.com/org/repo.git";
process.env.GIT_ACCESS_TOKEN = "test-token";
process.env.GIT_DEFAULT_BRANCH = "main";
process.env.WORKSPACE_DIR = workspace;
process.env.WORKTREE_DIR = worktrees;
process.env.AUTO_PUSH = "true";
process.env.GIT_SKIP_HOOKS = "true";

const { GitRemoteUnavailableError, gitService } = await import("../dist/services/gitService.js");

await gitService.mergeIntoBranch("feature", "main", "merge feature", async ({ worktreePath }) => {
  await writeFile(join(worktreePath, "merge.txt"), "main + feature\n");
});

await gitService.cherryPickCommitIntoBranch(pickSha, "release", async ({ worktreePath }) => {
  await writeFile(join(worktreePath, "pick.txt"), "release + source\n");
});

let conflictFailedSafely = false;
try {
  await gitService.cherryPickCommitIntoBranch(pickSha, "failure");
} catch {
  conflictFailedSafely = true;
}

const originalRemoteUrl = git(workspace, "remote", "get-url", "origin");
let remoteFailureWasRetryable = false;
try {
  await gitService.cherryPickCommitIntoBranch(pickSha, "push-failure", async ({ worktreePath }) => {
    await writeFile(join(worktreePath, "pick.txt"), "release + source\n");
    git(workspace, "remote", "set-url", "origin", join(root, "missing.git"));
  });
} catch (err) {
  remoteFailureWasRetryable = err instanceof GitRemoteUnavailableError;
} finally {
  git(workspace, "remote", "set-url", "origin", originalRemoteUrl);
}

const localBranchAfterPushFailure = git(workspace, "branch", "--list", "push-failure");
await gitService.cherryPickCommitIntoBranch(pickSha, "push-failure", async ({ worktreePath }) => {
  await writeFile(join(worktreePath, "pick.txt"), "release + source\n");
});

git(workspace, "fetch", "origin");
const merged = git(workspace, "show", "origin/main:merge.txt");
const picked = git(workspace, "show", "origin/release:pick.txt");
const failedTarget = git(workspace, "show", "origin/failure:pick.txt");
const retriedTarget = git(workspace, "show", "origin/push-failure:pick.txt");
const localMainFile = git(workspace, "show", "main:merge.txt");
const worktreeList = git(workspace, "worktree", "list", "--porcelain");

if (merged !== "main + feature") throw new Error(`merge 结果错误: ${merged}`);
if (picked !== "release + source") throw new Error(`cherry-pick 结果错误: ${picked}`);
if (!conflictFailedSafely) throw new Error("未配置 resolver 的冲突应当失败");
if (failedTarget !== "release") throw new Error(`失败目标分支被意外修改: ${failedTarget}`);
if (!remoteFailureWasRetryable) throw new Error("push 失败未识别为可重试远程错误");
if (localBranchAfterPushFailure) throw new Error("push 失败前不应更新本地目标分支");
if (retriedTarget !== "release + source") throw new Error(`恢复后的重试结果错误: ${retriedTarget}`);
if (localMainFile !== "main + feature") throw new Error(`本地 main 未同步: ${localMainFile}`);
if ((worktreeList.match(/^worktree /gm) ?? []).length !== 1) {
  throw new Error("临时 integration worktree 未清理");
}

console.log("integration worktree merge/cherry-pick verification passed");
await rm(root, { recursive: true, force: true });
