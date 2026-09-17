import type { Job, TaskMode } from "../types.js";
import { listJobs } from "./jobStore.js";
import { getProjectGitService } from "./projectRuntime.js";
import { listProjects } from "./projectRegistry.js";

export interface AnalyticsBreakdownItem {
  key: string;
  label: string;
  total: number;
  completed: number;
  failed: number;
  successRate: number;
}

export interface AnalyticsData {
  generatedAt: string;
  days: number;
  projectId?: string;
  availableProjects: Array<{ id: string; name: string }>;
  overview: {
    total: number;
    completed: number;
    failed: number;
    cancelled: number;
    active: number;
    pending: number;
    successRate: number;
    averageDurationMs: number;
  };
  daily: Array<{ date: string; total: number; completed: number; failed: number; cancelled: number }>;
  taskModes: AnalyticsBreakdownItem[];
  projects: AnalyticsBreakdownItem[];
  failures: Array<{ category: string; count: number }>;
  recentAnomalies: Array<{
    jobId: string;
    projectId: string;
    projectName: string;
    status: "failed" | "cancelled";
    category: string;
    message: string;
    time: string;
  }>;
}

export interface CodeChangeAnalytics {
  taskCount: number;
  measuredTaskCount: number;
  fileCount: number;
  additions: number;
  deletions: number;
  attentionTaskCount: number;
  averageFiles: number;
}

interface CachedDiffStats {
  files: number;
  additions: number;
  deletions: number;
  attention: boolean;
}

const diffStatsCache = new Map<string, CachedDiffStats>();
const dayMs = 24 * 60 * 60 * 1000;

function dateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function rangeStart(days: number): Date {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - days + 1);
  return start;
}

function resolveTaskMode(job: Job): TaskMode {
  if (job.taskMode) return job.taskMode;
  if (job.testCaseDocument) return "test-case";
  if (job.requiresConfirm || job.planSummary || job.sourceCommitSha || job.commitSha) return "code";
  return "question";
}

function successRate(completed: number, failed: number): number {
  const decided = completed + failed;
  return decided > 0 ? Math.round((completed / decided) * 1000) / 10 : 0;
}

function classifyFailure(job: Job): string {
  if (job.status === "cancelled") return "用户取消";
  const detail = `${job.message || ""} ${job.error || ""}`.toLowerCase();
  if (/build|compile|tsc|vite|webpack|构建|编译/.test(detail)) return "构建或编译";
  if (/git|merge|push|pull|cherry|conflict|合并|冲突|仓库/.test(detail)) return "Git 或合并";
  if (/plan|方案|澄清/.test(detail)) return "方案生成";
  if (/timeout|timed out|超时/.test(detail)) return "执行超时";
  if (/agent|claude|codex|进程|process|exit/.test(detail)) return "Agent 执行";
  return "其他失败";
}

function isAttentionPath(path: string): boolean {
  const normalized = path.toLowerCase();
  return /(^|\/)(auth|permission|security|login)(\/|\.|$)|token/.test(normalized)
    || /(^|\/)(routes?|api)(\/|\.|$)|\/services\/.*api/.test(normalized)
    || /migration|schema|database|\.sql$/.test(normalized)
    || /(^|\/)(config|router|store|layout)(\/|\.|$)|(^|\/)\.env|package(-lock)?\.json$/.test(normalized);
}

function buildBreakdown(jobs: Job[], keyOf: (job: Job) => string, labelOf: (key: string) => string): AnalyticsBreakdownItem[] {
  const grouped = new Map<string, { total: number; completed: number; failed: number }>();
  for (const job of jobs) {
    const key = keyOf(job);
    const item = grouped.get(key) ?? { total: 0, completed: 0, failed: 0 };
    item.total += 1;
    if (job.status === "completed") item.completed += 1;
    if (job.status === "failed") item.failed += 1;
    grouped.set(key, item);
  }
  return [...grouped.entries()]
    .map(([key, item]) => ({ key, label: labelOf(key), ...item, successRate: successRate(item.completed, item.failed) }))
    .sort((left, right) => right.total - left.total);
}

function selectedJobs(days: number, projectId?: string): { all: Job[]; ranged: Job[] } {
  const all = listJobs().filter((job) => !projectId || job.projectId === projectId);
  const startTime = rangeStart(days).getTime();
  return { all, ranged: all.filter((job) => new Date(job.createdAt).getTime() >= startTime) };
}

export function getAnalytics(days: number, projectId?: string): AnalyticsData {
  const projects = listProjects();
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  const { all, ranged } = selectedJobs(days, projectId);
  const completed = ranged.filter((job) => job.status === "completed").length;
  const failed = ranged.filter((job) => job.status === "failed").length;
  const cancelled = ranged.filter((job) => job.status === "cancelled").length;
  const durations = ranged
    .filter((job) => job.status === "completed" || job.status === "failed" || job.status === "cancelled")
    .map((job) => new Date(job.updatedAt).getTime() - new Date(job.createdAt).getTime())
    .filter((duration) => Number.isFinite(duration) && duration >= 0);

  const dailyMap = new Map<string, { date: string; total: number; completed: number; failed: number; cancelled: number }>();
  const start = rangeStart(days);
  for (let index = 0; index < days; index += 1) {
    const date = new Date(start.getTime() + index * dayMs);
    const key = dateKey(date);
    dailyMap.set(key, { date: key, total: 0, completed: 0, failed: 0, cancelled: 0 });
  }
  for (const job of ranged) {
    const item = dailyMap.get(dateKey(new Date(job.createdAt)));
    if (!item) continue;
    item.total += 1;
    if (job.status === "completed") item.completed += 1;
    if (job.status === "failed") item.failed += 1;
    if (job.status === "cancelled") item.cancelled += 1;
  }

  const anomalous = ranged.filter((job): job is Job & { status: "failed" | "cancelled" } =>
    job.status === "failed" || job.status === "cancelled"
  );
  const failureCounts = new Map<string, number>();
  for (const job of anomalous) {
    const category = classifyFailure(job);
    failureCounts.set(category, (failureCounts.get(category) ?? 0) + 1);
  }

  return {
    generatedAt: new Date().toISOString(),
    days,
    projectId,
    availableProjects: projects.map((project) => ({ id: project.id, name: project.name })),
    overview: {
      total: ranged.length,
      completed,
      failed,
      cancelled,
      active: all.filter((job) => ["planning", "running", "awaiting_confirm", "awaiting_input", "awaiting_merge"].includes(job.status)).length,
      pending: all.filter((job) => job.status === "pending").length,
      successRate: successRate(completed, failed),
      averageDurationMs: durations.length > 0 ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : 0,
    },
    daily: [...dailyMap.values()],
    taskModes: buildBreakdown(ranged, (job) => resolveTaskMode(job), (key) => ({ code: "功能修改", question: "项目问答", "test-case": "测试用例" }[key] ?? key)),
    projects: buildBreakdown(ranged, (job) => job.projectId, (key) => projectNames.get(key) ?? key),
    failures: [...failureCounts.entries()].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count),
    recentAnomalies: anomalous.slice(0, 20).map((job) => ({
      jobId: job.jobId,
      projectId: job.projectId,
      projectName: projectNames.get(job.projectId) ?? job.projectId,
      status: job.status,
      category: classifyFailure(job),
      message: (job.error || job.message || (job.status === "cancelled" ? "任务已取消" : "任务失败")).slice(0, 180),
      time: job.updatedAt,
    })),
  };
}

export async function getCodeChangeAnalytics(days: number, projectId?: string): Promise<CodeChangeAnalytics> {
  const { ranged } = selectedJobs(days, projectId);
  const codeJobs = ranged.filter((job) =>
    resolveTaskMode(job) === "code"
    && Boolean(job.sourceCommitSha || job.commitSha)
    && (job.status === "completed" || job.status === "awaiting_merge")
  );
  const byProject = new Map<string, Job[]>();
  for (const job of codeJobs) {
    const items = byProject.get(job.projectId) ?? [];
    items.push(job);
    byProject.set(job.projectId, items);
  }

  const measured = (await Promise.all([...byProject.entries()].map(async ([currentProjectId, jobs]) => {
    const gitService = getProjectGitService(currentProjectId);
    const results: CachedDiffStats[] = [];
    for (const job of jobs) {
      const commitSha = job.sourceCommitSha || job.commitSha;
      if (!commitSha) continue;
      const cacheKey = `${currentProjectId}:${commitSha}`;
      let stats = diffStatsCache.get(cacheKey);
      if (!stats) {
        try {
          const diff = await gitService.getCommitDiff(commitSha);
          stats = {
            files: diff.files.length,
            additions: diff.additions,
            deletions: diff.deletions,
            attention: diff.files.some((file) => isAttentionPath(file.path)),
          };
          diffStatsCache.set(cacheKey, stats);
        } catch {
          continue;
        }
      }
      results.push(stats);
    }
    return results;
  }))).flat();

  const fileCount = measured.reduce((sum, item) => sum + item.files, 0);
  return {
    taskCount: codeJobs.length,
    measuredTaskCount: measured.length,
    fileCount,
    additions: measured.reduce((sum, item) => sum + item.additions, 0),
    deletions: measured.reduce((sum, item) => sum + item.deletions, 0),
    attentionTaskCount: measured.filter((item) => item.attention).length,
    averageFiles: measured.length > 0 ? Math.round((fileCount / measured.length) * 10) / 10 : 0,
  };
}
