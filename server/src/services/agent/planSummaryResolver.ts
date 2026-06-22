import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const PLAN_FILE_PLACEHOLDER =
  /计划文件|等待执行|plan\s*file|written\s+to\s+.*plan|saved\s+(the\s+)?plan/i;

export function isPlanFilePlaceholder(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (PLAN_FILE_PLACEHOLDER.test(trimmed)) return true;
  if (trimmed.length < 80 && !/^#|\d+\.|文件|改动|修改|方案/.test(trimmed)) return true;
  return false;
}

export function pickPlanOutput(finalSummary: string, streamedText: string): string {
  const final = finalSummary.trim();
  const streamed = streamedText.trim();

  if (!final) return streamed;
  if (!streamed) return final;
  if (isPlanFilePlaceholder(final)) return streamed.length > final.length ? streamed : final;
  return streamed.length > final.length * 1.5 ? streamed : final;
}

export function readLatestPlanFile(repoPath: string, sinceMs?: number): string | undefined {
  const dirs = [join(homedir(), ".claude", "plans"), join(repoPath, "plans")];
  let best: { path: string; mtime: number } | undefined;

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".md")) continue;
        const path = join(dir, name);
        const mtime = statSync(path).mtimeMs;
        if (sinceMs && mtime < sinceMs - 10_000) continue;
        if (!best || mtime > best.mtime) best = { path, mtime };
      }
    } catch {
      // ignore unreadable plan directory
    }
  }

  if (!best) return undefined;
  try {
    const content = readFileSync(best.path, "utf8").trim();
    return content || undefined;
  } catch {
    return undefined;
  }
}

export function resolvePlanSummary(
  summary: string,
  repoPath: string,
  planStartedAt: Date
): string {
  const trimmed = summary.trim();
  if (trimmed && !isPlanFilePlaceholder(trimmed)) return trimmed;

  const fromFile = readLatestPlanFile(repoPath, planStartedAt.getTime());
  if (fromFile) return fromFile;

  return trimmed || "Plan 分析完成";
}
