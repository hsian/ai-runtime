import { getTapdConfig, type TapdConfig } from "../../config.js";
import { getAccessToken } from "./tapdClient.js";
import { load } from "cheerio";

export interface WorkTask {
  id: string;
  workspaceId: string;
  projectName: string;
  name: string;
  completed: string;
  owner: string;
  hoursField: string;
  pagesField: string;
  currentHours: string;
  currentPages: string;
  description: string;
}

type TapdRow = Record<string, string | null>;

async function request(cfg: TapdConfig, path: string, params: Record<string, string>, method: "GET" | "POST" = "GET"): Promise<unknown> {
  const token = await getAccessToken(cfg);
  const url = new URL(path, cfg.apiBase);
  if (method === "GET") Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  const response = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    ...(method === "POST" ? { body: new URLSearchParams(params).toString() } : {}),
  });
  const body = await response.json() as { status: number; info?: string; data: unknown };
  if (!response.ok || body.status !== 1) throw new Error(body.info || `TAPD 请求失败: ${response.status}`);
  return body.data;
}

function records(data: unknown, key: string): TapdRow[] {
  return Array.isArray(data) ? data.map((entry) => entry?.[key]).filter(Boolean) : [];
}

async function fields(cfg: TapdConfig, workspaceId: string): Promise<{ hours: string; pages: string }> {
  const rows = records(await request(cfg, "/tasks/custom_fields_settings", { workspace_id: workspaceId }), "CustomFieldConfig");
  const hours = rows.find((row) => row.name === "实际工时" && row.enabled === "1")?.custom_field;
  const pages = rows.find((row) => row.name === "页面数" && row.enabled === "1")?.custom_field;
  if (!hours || !pages || !/^custom_field_(?:one|two|three|four|five|six|seven|eight|\d+)$/.test(hours) || !/^custom_field_(?:one|two|three|four|five|six|seven|eight|\d+)$/.test(pages)) {
    throw new Error(`项目 ${workspaceId} 未配置“实际工时”或“页面数”任务字段`);
  }
  return { hours, pages };
}

export async function listWorkTasks(month: string, owner: string, workspaceIds: string[]): Promise<WorkTask[]> {
  const cfg = getTapdConfig();
  const start = `${month}-01 00:00:00`;
  const [year, value] = month.split("-").map(Number);
  const end = `${year + (value === 12 ? 1 : 0)}-${String(value === 12 ? 1 : value + 1).padStart(2, "0")}-01 00:00:00`;
  const all: WorkTask[] = [];
  for (const workspaceId of workspaceIds) {
    const project = cfg.workspaces.find((entry) => entry.id === workspaceId);
    if (!project) throw new Error(`未配置 TAPD 项目 ${workspaceId}`);
    const mapping = await fields(cfg, workspaceId);
    for (let page = 1; page <= 50; page++) {
      const batch = records(await request(cfg, "/tasks", { workspace_id: workspaceId, owner, limit: "200", page: String(page) }), "Task");
      for (const task of batch) {
        const owners = String(task.owner ?? "").split(";").map((name) => name.trim());
        const completed = String(task.completed ?? "");
        if (task.status !== "done" || !owners.includes(owner) || completed < start || completed >= end) continue;
        all.push({ id: String(task.id), workspaceId, projectName: project.name || workspaceId,
          name: String(task.name ?? ""), completed, owner: String(task.owner ?? ""),
          hoursField: mapping.hours, pagesField: mapping.pages,
          currentHours: String(task[mapping.hours] ?? ""), currentPages: String(task[mapping.pages] ?? ""),
          description: load(String(task.description ?? "")).text().slice(0, 4000) });
      }
      if (batch.length < 200) break;
      if (page === 50) throw new Error(`项目 ${workspaceId} 任务超过分页上限`);
    }
  }
  return [...new Map(all.map((task) => [`${task.workspaceId}:${task.id}`, task])).values()]
    .sort((a, b) => a.completed.localeCompare(b.completed));
}

export function scoreTask(task: WorkTask): number {
  const name = `${task.name} ${task.description}`;
  let score = 3;
  for (const [pattern, weight] of [
    [/新增|开发|建设|实现|重构|导入|导出|报表|统计|联调|对接|工作流/, 2],
    [/多个|批量|跨组织|复杂|权限|全流程|配置|大屏/, 2],
    [/优化|修改|调整|增加|完善/, 1],
    [/文案|提示|文字|颜色|logo|隐藏|显示|按钮|校验/, -1],
  ] as const) if (pattern.test(name)) score += weight;
  return Math.max(1, Math.min(10, score));
}

export function allocateHours(tasks: WorkTask[], target: number): Array<{ task: WorkTask; hours: number; pages: number; score: number }> {
  const editable = tasks.filter((task) => task.currentHours === "" && task.currentPages === "");
  if (editable.length === 0) return [];
  const existing = tasks.reduce((sum, task) => sum + (Number(task.currentHours) || 0), 0);
  const remaining = target - existing;
  if (remaining < editable.length || remaining > editable.length * 16) throw new Error("目标工时与已有工时、可填写任务数不匹配，请调整目标或已有值");
  const scores = editable.map(scoreTask);
  const hours = editable.map(() => 1);
  let left = remaining - editable.length;
  while (left > 0) {
    const index = hours.reduce((best, value, i) => value < 16 && (best < 0 || scores[i] / (value + 1) > scores[best] / (hours[best] + 1)) ? i : best, -1);
    if (index < 0) break;
    hours[index] += 1;
    left -= 1;
  }
  return editable.map((task, i) => ({ task, hours: hours[i], pages: Math.max(1, Math.round(hours[i] / 3.5)), score: scores[i] }));
}

export async function updateWorkTask(task: WorkTask, hours: number, pages: number, currentUser: string): Promise<void> {
  const cfg = getTapdConfig();
  const before = records(await request(cfg, "/tasks", { workspace_id: task.workspaceId, id: task.id }), "Task")[0];
  if (!before || before.status !== "done" || String(before[task.hoursField] ?? "") !== task.currentHours || String(before[task.pagesField] ?? "") !== task.currentPages) {
    throw new Error("任务已变化，请重新生成预览");
  }
  await request(cfg, "/tasks", {
    id: task.id, workspace_id: task.workspaceId, current_user: currentUser,
    [task.hoursField]: String(hours), [task.pagesField]: String(pages),
  }, "POST");
  const updated = records(await request(cfg, "/tasks", { workspace_id: task.workspaceId, id: task.id }), "Task")[0];
  if (!updated || String(updated[task.hoursField] ?? "") !== String(hours) || String(updated[task.pagesField] ?? "") !== String(pages)) {
    throw new Error("TAPD 未返回预期的工时和页面数，请手动核对后重试");
  }
}
