import { readFile } from "fs/promises";
import { networkInterfaces } from "os";
import { dirname, join, resolve } from "path";
import { config } from "../config.js";

interface DevPreviewResult {
  filter: string;
  url: string;
}

interface PreviewTarget {
  filter: string;
  packageDir?: string;
}

function getLanHost(): string | undefined {
  const addresses = Object.values(networkInterfaces())
    .flatMap((items) => items ?? [])
    .filter((item) => item.family === "IPv4" && !item.internal)
    .map((item) => item.address);

  return addresses.find((address) => address.startsWith("192.168.")) ?? addresses[0];
}

function normalizePreviewHost(host?: string): string {
  const fallback = getLanHost() ?? "localhost";
  if (!host) return fallback;

  const trimmed = host.trim();
  if (!trimmed) return fallback;

  try {
    const parsed = new URL(trimmed.includes("://") ? trimmed : `http://${trimmed}`);
    if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") return fallback;
    return parsed.hostname;
  } catch {
    const withoutPort = trimmed.replace(/:\d+$/, "");
    return withoutPort === "localhost" || withoutPort === "127.0.0.1" ? fallback : withoutPort;
  }
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

export async function resolveJobPreviewLink(input: {
  repoPath: string;
  changedFiles: string[];
  previewHost?: string;
}): Promise<DevPreviewResult | undefined> {
  if (!config.PREVIEW_DEV_ENABLED) return undefined;

  const target = await inferTargetFromChangedFiles(input.repoPath, input.changedFiles);
  if (!target) return undefined;
  const { filter } = target;
  const port = await readDevPort(target.packageDir);
  if (!port) return undefined;

  const host = normalizePreviewHost(input.previewHost);
  return { filter, url: `http://${host}:${port}/` };
}
