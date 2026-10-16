import type { SimpleGit } from "simple-git";
import type { GitCommitDiff, GitCommitDiffFile, GitDiffFileStatus } from "../gitService.js";

const EMPTY_GIT_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

function toDiffFileStatus(value: string): GitDiffFileStatus {
  if (value === "A") return "added";
  if (value === "D") return "deleted";
  if (value === "T") return "type_changed";
  return "modified";
}

export async function readCommitDiff(
  git: SimpleGit,
  commitSha: string,
  filePath: string | undefined,
  baseCommitSha: string | undefined,
  assertPath: (path: string) => void,
): Promise<GitCommitDiff> {
  const resolvedCommit = (await git.revparse([`${commitSha}^{commit}`])).trim();
  const parentsLine = (await git.raw(["rev-list", "--parents", "-n", "1", resolvedCommit])).trim();
  if (baseCommitSha && !/^[0-9a-f]{7,64}$/i.test(baseCommitSha)) throw new Error("基线提交编号无效");
  const parentCommit = baseCommitSha ? (await git.revparse([`${baseCommitSha}^{commit}`])).trim() : parentsLine.split(/\s+/)[1] || EMPTY_GIT_TREE_SHA;
  const diffRange = [parentCommit, resolvedCommit];

  const [nameStatusOutput, numstatOutput] = await Promise.all([
    git.raw(["-c", "core.quotepath=false", "diff", "--name-status", "--no-renames", ...diffRange]),
    git.raw(["-c", "core.quotepath=false", "diff", "--numstat", "--no-renames", ...diffRange]),
  ]);

  const stats = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  for (const line of numstatOutput.split(/\r?\n/)) {
    if (!line) continue;
    const [added = "0", deleted = "0", ...pathParts] = line.split("\t");
    const path = pathParts.join("\t");
    if (!path) continue;
    const binary = added === "-" || deleted === "-";
    stats.set(path, {
      additions: binary ? 0 : Number.parseInt(added, 10) || 0,
      deletions: binary ? 0 : Number.parseInt(deleted, 10) || 0,
      binary,
    });
  }

  const files = nameStatusOutput
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line): GitCommitDiffFile | undefined => {
      const [statusCode = "M", ...pathParts] = line.split("\t");
      const path = pathParts.join("\t");
      if (!path) return undefined;
      const stat = stats.get(path) ?? { additions: 0, deletions: 0, binary: false };
      return { path, status: toDiffFileStatus(statusCode[0]), ...stat };
    })
    .filter((file): file is GitCommitDiffFile => Boolean(file));

  let patch: string | undefined;
  if (filePath) {
    assertPath(filePath);
    if (!files.some((file) => file.path === filePath)) {
      throw new Error("该文件不属于本次代码改动");
    }
    patch = await git.raw([
      "-c",
      "core.quotepath=false",
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--no-renames",
      "--unified=3",
      ...diffRange,
      "--",
      filePath,
    ]);
  }

  return {
    commitSha: resolvedCommit,
    files,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
    selectedFile: filePath,
    patch,
  };
}
