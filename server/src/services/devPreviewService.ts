import { spawn, type ChildProcess } from "child_process";
import { readFile } from "fs/promises";
import { networkInterfaces } from "os";
import { dirname, join, resolve } from "path";
import { config } from "../config.js";

interface PreviewProcess {
  jobId: string;
  child: ChildProcess;
  filter: string;
  url?: string;
}

interface DevPreviewResult {
  filter: string;
  url: string;
}

interface PreviewTarget {
  filter: string;
  packageDir?: string;
}

let currentPreview: PreviewProcess | undefined;

function pnpmCommand(): string {
  return "pnpm";
}

function getLanHost(): string | undefined {
  const addresses = Object.values(networkInterfaces())
    .flatMap((items) => items ?? [])
    .filter((item) => item.family === "IPv4" && !item.internal)
    .map((item) => item.address);

  return addresses.find((address) => address.startsWith("192.168.")) ?? addresses[0];
}

function normalizePreviewUrl(raw: string): string {
  const cleaned = raw.replace(/0\.0\.0\.0|\[::\]/, "localhost").replace(/[),.;]+$/, "");
  const lanHost = getLanHost();
  if (!lanHost) return cleaned;

  try {
    const url = new URL(cleaned);
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
      url.hostname = lanHost;
      return url.toString();
    }
  } catch {
    // Keep the original string if it is not a valid URL.
  }

  return cleaned;
}

function findPreviewUrl(output: string): string | undefined {
  const match = output.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::\])(?::\d+)(?:\/[^\s]*)?/i);
  return match ? normalizePreviewUrl(match[0]) : undefined;
}

function inferWorkspacePathFilter(changedFile: string): string | undefined {
  const normalized = changedFile.replace(/\\/g, "/");
  const match = normalized.match(/^(apps|app|packages|sites|examples)\/([^/]+)/);
  return match ? `./${match[1]}/${match[2]}` : undefined;
}

function inferWorkspacePackageDir(repoPath: string, changedFile: string): string | undefined {
  const normalized = changedFile.replace(/\\/g, "/");
  const match = normalized.match(/^(apps|app|packages|sites|examples)\/([^/]+)/);
  return match ? resolve(repoPath, match[1], match[2]) : undefined;
}

async function readPackageName(packageJsonPath: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(packageJsonPath, "utf8")) as { name?: unknown };
    return typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : undefined;
  } catch {
    return undefined;
  }
}

async function readDevPort(packageDir?: string): Promise<number | undefined> {
  if (!packageDir) return undefined;

  try {
    const envText = await readFile(join(packageDir, ".env.dev"), "utf8");
    const match = envText.match(/^\s*VITE_PORT\s*=\s*['"]?(\d+)['"]?/m);
    return match ? Number(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

async function probeUrl(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_000);
  try {
    await fetch(url, { signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function inferTargetFromChangedFiles(repoPath: string, changedFiles: string[]): Promise<PreviewTarget | undefined> {
  const root = resolve(repoPath);
  const scores = new Map<string, { count: number; packageDir?: string }>();
  const pathScores = new Map<string, { count: number; packageDir?: string }>();
  const packageNameCache = new Map<string, string | undefined>();

  for (const file of changedFiles) {
    const pathFilter = inferWorkspacePathFilter(file);
    if (pathFilter) {
      const prev = pathScores.get(pathFilter);
      pathScores.set(pathFilter, {
        count: (prev?.count ?? 0) + 1,
        packageDir: prev?.packageDir ?? inferWorkspacePackageDir(root, file),
      });
    }

    let current = resolve(root, dirname(file));

    while (current.startsWith(root) && current !== root) {
      const packageJsonPath = join(current, "package.json");
      let packageName = packageNameCache.get(packageJsonPath);
      if (!packageNameCache.has(packageJsonPath)) {
        packageName = await readPackageName(packageJsonPath);
        packageNameCache.set(packageJsonPath, packageName);
      }

      if (packageName) {
        const prev = scores.get(packageName);
        scores.set(packageName, { count: (prev?.count ?? 0) + 1, packageDir: prev?.packageDir ?? current });
        break;
      }

      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  const byPackageName = Array.from(scores.entries()).sort((a, b) => b[1].count - a[1].count)[0];
  if (byPackageName) return { filter: byPackageName[0], packageDir: byPackageName[1].packageDir };

  const byPath = Array.from(pathScores.entries()).sort((a, b) => b[1].count - a[1].count)[0];
  return byPath ? { filter: byPath[0], packageDir: byPath[1].packageDir } : undefined;
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.killed || child.exitCode != null) return;

  if (process.platform === "win32" && child.pid) {
    await new Promise<void>((resolveStop) => {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
      });
      killer.on("exit", () => resolveStop());
      killer.on("error", () => resolveStop());
    });
    return;
  }

  child.kill("SIGTERM");
}

export async function stopJobPreview(jobId?: string): Promise<void> {
  if (!currentPreview) return;
  if (jobId && currentPreview.jobId !== jobId) return;

  const preview = currentPreview;
  currentPreview = undefined;
  await stopProcess(preview.child);
}

export async function startJobPreview(input: {
  jobId: string;
  repoPath: string;
  changedFiles: string[];
}): Promise<DevPreviewResult | undefined> {
  if (!config.PREVIEW_DEV_ENABLED) return undefined;

  const target = await inferTargetFromChangedFiles(input.repoPath, input.changedFiles);
  if (!target) return undefined;
  const { filter } = target;
  const expectedPort = await readDevPort(target.packageDir);
  const expectedLocalUrl = expectedPort ? `http://localhost:${expectedPort}/` : undefined;
  const expectedDisplayUrl = expectedLocalUrl ? normalizePreviewUrl(expectedLocalUrl) : undefined;

  await stopJobPreview();

  const child = spawn(pnpmCommand(), ["--filter", filter, "run", "dev"], {
    cwd: input.repoPath,
    env: process.env,
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });

  currentPreview = { jobId: input.jobId, child, filter };

  return await new Promise<DevPreviewResult>((resolvePreview, rejectPreview) => {
    let output = "";
    let settled = false;
    let probe: ReturnType<typeof setInterval> | undefined;
    const timeout = setTimeout(() => {
      finishWithError(new Error(`预览服务启动超时，未检测到本地访问地址（filter: ${filter}）`));
    }, config.PREVIEW_DEV_TIMEOUT_MS);

    const finish = (url: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (probe) clearInterval(probe);
      if (currentPreview?.child === child) {
        currentPreview.url = url;
      }
      resolvePreview({ filter, url });
    };

    const finishWithError = (err: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (probe) clearInterval(probe);
      void stopJobPreview(input.jobId);
      rejectPreview(err);
    };

    const onData = (chunk: Buffer): void => {
      output += chunk.toString();
      const url = findPreviewUrl(output);
      if (url) finish(url);
    };

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    if (expectedLocalUrl && expectedDisplayUrl) {
      probe = setInterval(() => {
        void probeUrl(expectedLocalUrl).then((ready) => {
          if (ready) {
            finish(expectedDisplayUrl);
          }
        });
      }, 500);
      child.on("exit", () => {
        if (probe) clearInterval(probe);
      });
    }
    child.on("error", (err) => finishWithError(err));
    child.on("exit", (code) => {
      if (!settled) {
        finishWithError(new Error(`预览服务启动失败，进程退出码: ${code ?? "unknown"}`));
      }
    });
  });
}
