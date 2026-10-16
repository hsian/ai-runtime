import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { test } from "node:test";
import { simpleGit } from "simple-git";
import { readCommitDiff } from "./commitDiff.js";

test("commit diffs retain root commits, cumulative changes, binary files and file boundaries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runtime-commit-diff-"));
  try {
    const git = simpleGit(directory);
    await git.init();
    await git.addConfig("user.name", "Diff Test");
    await git.addConfig("user.email", "diff@example.invalid");
    await git.addConfig("core.autocrlf", "false");
    await writeFile(join(directory, "说明.txt"), "original\n");
    await writeFile(join(directory, "remove.txt"), "obsolete\n");
    await git.add(".");
    const first = (await git.commit("initial fixture")).commit;
    const assertPath = (file: string) => {
      if (!resolve(directory, file).startsWith(resolve(directory) + sep)) throw Error("outside repository");
    };
    const root = await readCommitDiff(git, first, "说明.txt", undefined, assertPath);
    assert.equal(root.files.length, 2);
    assert.equal(root.files.every(file => file.status === "added"), true);
    assert.match(root.patch!, /\+original/);

    await writeFile(join(directory, "说明.txt"), "updated\n");
    await git.add(".");
    await git.commit("update text");
    await writeFile(join(directory, "binary.bin"), Buffer.from([0, 1, 2, 0]));
    await unlink(join(directory, "remove.txt"));
    await git.add(".");
    const latest = (await git.commit("binary and deletion")).commit;
    const cumulative = await readCommitDiff(git, latest, "说明.txt", first, assertPath);
    assert.deepEqual(cumulative.files.map(file => file.path).sort(), ["binary.bin", "remove.txt", "说明.txt"]);
    assert.equal(cumulative.files.find(file => file.path === "binary.bin")?.binary, true);
    assert.equal(cumulative.files.find(file => file.path === "remove.txt")?.status, "deleted");
    assert.equal(cumulative.additions, 1);
    assert.equal(cumulative.deletions, 2);
    assert.match(cumulative.patch!, /-original/);
    assert.match(cumulative.patch!, /\+updated/);
    const single = await readCommitDiff(git, latest, undefined, undefined, assertPath);
    assert.equal(single.files.some(file => file.path === "说明.txt"), false);
    await assert.rejects(readCommitDiff(git, latest, "missing.txt", first, assertPath), /不属于本次代码改动/);
    await assert.rejects(readCommitDiff(git, latest, "../outside.txt", first, assertPath), /outside repository/);
    await assert.rejects(readCommitDiff(git, latest, undefined, "--invalid", assertPath), /基线提交编号无效/);
  } finally {
    const target = resolve(directory);
    if (!target.startsWith(resolve(tmpdir()) + sep) || !target.includes("runtime-commit-diff-")) throw Error("unsafe fixture cleanup");
    await rm(target, { recursive: true, force: true });
  }
});
