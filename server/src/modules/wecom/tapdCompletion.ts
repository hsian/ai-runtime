import type Database from "better-sqlite3";
import { getTapdConfig, type TapdConfig } from "../../config.js";
import { getDatabase } from "../../services/database.js";
import { listIterations, listIterationTasks, listStoryTasks, type TapdTask } from "../../services/tapd/tapdClient.js";
import type { TapdCompletionOptions } from "./config.js";

const INTERVAL = 10 * 60_000;
const shanghai = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric",
  month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });

function localParts(date: Date) {
  return Object.fromEntries(shanghai.formatToParts(date).map(part => [part.type, part.value]));
}

export function notificationHours(date: Date): boolean {
  const parts = localParts(date);
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  return minute >= 9 * 60 && minute <= 19 * 60;
}

export function currentMonthIteration(name: string, date: Date): boolean {
  const parts = localParts(date);
  const match = name.replace(/\s/g, "").match(/(\d{4})年(\d{1,2})月/);
  return Boolean(match && Number(match[1]) === Number(parts.year) && Number(match[2]) === Number(parts.month));
}

export function tapdTimestamp(date: Date): string {
  const parts = localParts(date);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function completionAfter(task: TapdTask, cursor: number): boolean {
  if (!task.completed || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(task.completed)) return false;
  return Date.parse(task.completed.replace(" ", "T") + "+08:00") >= cursor;
}

function owners(value = ""): string[] {
  return [...new Set(value.split(/[;；,，]/).map(name => name.trim()).filter(Boolean))];
}

interface TaskState { status: string; sequence: number }
interface Notice { id: string; target_id: string; owner_name: string; content: string }

export interface CompletionDependencies {
  db: Database.Database;
  cfg: TapdConfig;
  now: () => Date;
  canSend: (target?: string) => boolean;
  send: (target: string, content: string) => Promise<unknown>;
  iterations: typeof listIterations;
  tasks: typeof listIterationTasks;
  storyTasks: typeof listStoryTasks;
}

// Persistent state and outbox are separate from AI Runtime's code-job notifications.
export class TapdCompletionMonitor {
  private busy = false;
  private stopped = false;
  private slot = -1;

  constructor(private botId: string, private options: TapdCompletionOptions, private deps: CompletionDependencies) {
    deps.db.exec(`
      CREATE TABLE IF NOT EXISTS tapd_completion_scopes (
        bot_id TEXT NOT NULL, workspace_id TEXT NOT NULL, iteration_id TEXT NOT NULL, cursor INTEGER NOT NULL,
        PRIMARY KEY(bot_id, workspace_id, iteration_id)
      );
      CREATE TABLE IF NOT EXISTS tapd_completion_tasks (
        bot_id TEXT NOT NULL, workspace_id TEXT NOT NULL, task_id TEXT NOT NULL,
        status TEXT NOT NULL, sequence INTEGER NOT NULL,
        PRIMARY KEY(bot_id, workspace_id, task_id)
      );
      CREATE TABLE IF NOT EXISTS tapd_completion_notices (
        id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        target_id TEXT NOT NULL, owner_name TEXT NOT NULL, content TEXT NOT NULL, sent_at TEXT
      );
    `);
  }

  stop(): void { this.stopped = true; }

  async tick(): Promise<void> {
    const now = this.deps.now();
    const slot = Math.floor(now.getTime() / INTERVAL);
    if (this.stopped || this.busy || !notificationHours(now) || !this.deps.canSend() || slot === this.slot) return;
    this.busy = true;
    this.slot = slot;
    try {
      for (const workspaceId of this.options.workspaceIds) {
        if (this.stopped || !notificationHours(this.deps.now())) break;
        try { await this.pollWorkspace(workspaceId, now); }
        catch { console.warn(`[TAPD通知] 项目 ${workspaceId} 查询失败，保留进度等待下一轮重试`); }
      }
      await this.flush();
    } finally { this.busy = false; }
  }

  private async pollWorkspace(workspaceId: string, now: Date): Promise<void> {
    const { db, cfg } = this.deps;
    const iterations = await this.deps.iterations(workspaceId, cfg);
    for (const iteration of iterations.filter(item => currentMonthIteration(item.name, now))) {
      if (this.stopped || !notificationHours(this.deps.now())) return;
      const scope = db.prepare(`SELECT cursor FROM tapd_completion_scopes
        WHERE bot_id = ? AND workspace_id = ? AND iteration_id = ?`)
        .get(this.botId, workspaceId, iteration.id) as { cursor: number } | undefined;
      // Overlap by one minute; never advance the watermark on API/transaction failure.
      const tasks = await this.deps.tasks(iteration.id, { workspaceId,
        modified: scope ? `>${tapdTimestamp(new Date(scope.cursor - 60_000))}` : undefined }, cfg);
      if (this.stopped) return;
      const updates: { task: TapdTask; sequence: number }[] = [];
      const notices: Notice[] = [];
      const siblings = new Map<string, TapdTask[]>();
      for (const task of tasks) {
        const previous = db.prepare(`SELECT status, sequence FROM tapd_completion_tasks
          WHERE bot_id = ? AND workspace_id = ? AND task_id = ?`)
          .get(this.botId, workspaceId, task.id) as TaskState | undefined;
        const backend = task.name.trim().startsWith("后端");
        if (!backend && !previous) continue;
        const newlyDone = Boolean(scope && backend && task.status === "done" &&
          (previous ? previous.status !== "done" : completionAfter(task, scope.cursor)));
        const sequence = (previous?.sequence ?? 0) + (newlyDone ? 1 : 0);
        updates.push({ task, sequence });
        if (!newlyDone || !task.story_id || task.story_id === "0") continue;
        if (!siblings.has(task.story_id)) {
          siblings.set(task.story_id, await this.deps.storyTasks(task.story_id, workspaceId, cfg));
          if (this.stopped) return;
        }
        const fronts = siblings.get(task.story_id)!.filter(front => front.name.trim().startsWith("前端") &&
          front.story_id === task.story_id &&
          front.iteration_id && iterations.some(item => item.id === front.iteration_id && currentMonthIteration(item.name, now)));
        for (const owner of new Set(fronts.flatMap(front => owners(front.owner)))) {
          if (!Object.hasOwn(this.options.recipients, owner)) continue;
          const target = this.options.recipients[owner];
          const workspaceName = cfg.workspaces.find(item => item.id === workspaceId)?.name ?? workspaceId;
          notices.push({ id: JSON.stringify([this.botId, workspaceId, task.id, sequence, target]),
            target_id: target, owner_name: owner,
            content: `【后端完成提醒】\n${owner}，你负责的前端任务对应的后端任务已完成。\n\n项目：${workspaceName}\n迭代：${iteration.name}\n后端任务：${task.name.slice(0, 500)}\n后端负责人：${task.owner || "未填写"}\n\n需求：https://www.tapd.cn/${workspaceId}/stories/view/${task.story_id}\n后端任务：https://www.tapd.cn/${workspaceId}/tasks/view/${task.id}` });
        }
      }
      if (this.stopped) return;
      db.transaction(() => {
        for (const { task, sequence } of updates) db.prepare(`INSERT INTO tapd_completion_tasks
          (bot_id, workspace_id, task_id, status, sequence) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(bot_id, workspace_id, task_id) DO UPDATE SET status = excluded.status, sequence = excluded.sequence`)
          .run(this.botId, workspaceId, task.id, task.status ?? "", sequence);
        for (const notice of notices) db.prepare(`INSERT OR IGNORE INTO tapd_completion_notices
          (id, bot_id, workspace_id, target_id, owner_name, content) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(notice.id, this.botId, workspaceId, notice.target_id, notice.owner_name, notice.content);
        db.prepare(`INSERT INTO tapd_completion_scopes (bot_id, workspace_id, iteration_id, cursor) VALUES (?, ?, ?, ?)
          ON CONFLICT(bot_id, workspace_id, iteration_id) DO UPDATE SET cursor = excluded.cursor`)
          .run(this.botId, workspaceId, iteration.id, now.getTime());
      })();
    }
  }

  private async flush(): Promise<void> {
    const pending = this.deps.db.prepare(`SELECT id, workspace_id, target_id, owner_name, content
      FROM tapd_completion_notices WHERE bot_id = ? AND sent_at IS NULL ORDER BY rowid`)
      .all(this.botId) as (Notice & { workspace_id: string })[];
    for (const notice of pending) {
      if (this.stopped || !notificationHours(this.deps.now()) || !this.deps.canSend()) return;
      if (!this.options.workspaceIds.includes(notice.workspace_id) ||
        !Object.hasOwn(this.options.recipients, notice.owner_name) ||
        this.options.recipients[notice.owner_name] !== notice.target_id || !this.deps.canSend(notice.target_id)) continue;
      const [, , taskId, sequence] = JSON.parse(notice.id) as [string, string, string, number, string];
      const state = this.deps.db.prepare(`SELECT status, sequence FROM tapd_completion_tasks
        WHERE bot_id = ? AND workspace_id = ? AND task_id = ?`)
        .get(this.botId, notice.workspace_id, taskId) as TaskState | undefined;
      if (!state || state.status !== "done" || state.sequence !== sequence) {
        this.deps.db.prepare("DELETE FROM tapd_completion_notices WHERE id = ?").run(notice.id);
        continue;
      }
      try {
        await this.deps.send(notice.target_id, notice.content);
        this.deps.db.prepare("UPDATE tapd_completion_notices SET sent_at = ? WHERE id = ?")
          .run(this.deps.now().toISOString(), notice.id);
      } catch { console.warn("[TAPD通知] 发送失败，保留消息等待下一轮重试"); }
    }
  }
}

export function startTapdCompletionMonitor(botId: string, options: TapdCompletionOptions,
  canSend: CompletionDependencies["canSend"], send: CompletionDependencies["send"]): () => void {
  const cfg = getTapdConfig();
  if (options.workspaceIds.some(id => !cfg.workspaces.some(workspace => workspace.id === id))) {
    throw new Error("完成通知项目必须已经在 TAPD_WORKSPACES 中配置");
  }
  const monitor = new TapdCompletionMonitor(botId, options, {
    db: getDatabase(), cfg, now: () => new Date(), canSend, send,
    iterations: listIterations, tasks: listIterationTasks, storyTasks: listStoryTasks,
  });
  // Cheap local clock checks; TAPD queries run at most once per ten-minute slot.
  const timer = setInterval(() => { void monitor.tick().catch(() => console.warn("[TAPD通知] 检查失败")); }, 30_000);
  timer.unref();
  return () => { monitor.stop(); clearInterval(timer); };
}
