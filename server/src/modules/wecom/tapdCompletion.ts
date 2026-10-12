import type Database from "better-sqlite3";
import { getTapdConfig, type TapdConfig } from "../../config.js";
import { getDatabase } from "../../services/database.js";
import { listIterations, getIterationWorkItems, type TapdTask, type TapdStory } from "../../services/tapd/tapdClient.js";
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

function owners(value = ""): string[] {
  return [...new Set(value.split(/[;；,，]/).map(name => name.trim()).filter(Boolean))];
}

function currentTapdLinks(content: string): string {
  return content.replace(/https:\/\/www\.tapd\.cn\/(\d+)\/(stories|tasks)\/view\/(\d+)/g,
    (_url, workspace: string, type: string, id: string) =>
      `https://www.tapd.cn/tapd_fe/${workspace}/${type === "stories" ? "story" : "task"}/detail/${id}`);
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
  workItems: typeof getIterationWorkItems;
}

// Persistent state and outbox are separate from AI Runtime's code-job notifications.
export class TapdCompletionMonitor {
  private busy = false;
  private stopped = false;
  private slot = -1;
  private snapshots = new Map<string, { tasks: TapdTask[]; stories: TapdStory[] }>();

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
    this.snapshots.clear();
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
    const current = iterations.filter(item => currentMonthIteration(item.name, now));
    const snapshots = [];
    for (const iteration of current) {
      if (this.stopped || !notificationHours(this.deps.now())) return;
      const workItems = await this.deps.workItems(iteration.id, workspaceId, cfg);
      snapshots.push({ iteration, stories: workItems.stories,
        tasks: [...workItems.stories.flatMap(story => story.tasks), ...workItems.orphanTasks] });
    }
    if (this.stopped) return;
    const workspaceTasks = snapshots.flatMap(snapshot => snapshot.tasks);
    const workspaceStories = snapshots.flatMap(snapshot => snapshot.stories);
    for (const { iteration, tasks } of snapshots) {
      if (this.stopped || !notificationHours(this.deps.now())) return;
      const scope = db.prepare(`SELECT cursor FROM tapd_completion_scopes
        WHERE bot_id = ? AND workspace_id = ? AND iteration_id = ?`)
        .get(this.botId, workspaceId, iteration.id) as { cursor: number } | undefined;
      const updates: { task: TapdTask; sequence: number }[] = [];
      const notices: Notice[] = [];
      for (const task of tasks) {
        const previous = db.prepare(`SELECT status, sequence FROM tapd_completion_tasks
          WHERE bot_id = ? AND workspace_id = ? AND task_id = ?`)
          .get(this.botId, workspaceId, task.id) as TaskState | undefined;
        const backend = task.name.trim().startsWith("后端");
        if (!backend && !previous) continue;
        // A new task can already be completed when it first becomes visible to
        // the API. Comparing its completion time to the last poll loses it
        // permanently. Only the initial scope snapshot is a silent baseline.
        const newlyDone = Boolean(scope && backend && task.status === "done" && previous?.status !== "done");
        const sequence = (previous?.sequence ?? 0) + (newlyDone ? 1 : 0);
        updates.push({ task, sequence });
        if (!newlyDone || !task.story_id || !workspaceStories.some(story => story.id === task.story_id)) continue;
        const fronts = workspaceTasks.filter(front => front.name.trim().startsWith("前端") &&
          front.story_id === task.story_id &&
          front.iteration_id && iterations.some(item => item.id === front.iteration_id && currentMonthIteration(item.name, now)));
        for (const owner of new Set(fronts.flatMap(front => owners(front.owner)))) {
          if (!Object.hasOwn(this.options.recipients, owner)) continue;
          const target = this.options.recipients[owner];
          const workspaceName = cfg.workspaces.find(item => item.id === workspaceId)?.name ?? workspaceId;
          notices.push({ id: JSON.stringify([this.botId, workspaceId, task.id, sequence, target]),
            target_id: target, owner_name: owner,
            content: `【后端完成提醒】\n${owner}，你负责的前端任务对应的后端任务已完成。\n\n项目：${workspaceName}\n迭代：${iteration.name}\n后端任务：${task.name.slice(0, 500)}\n后端负责人：${task.owner || "未填写"}\n\n需求：https://www.tapd.cn/tapd_fe/${workspaceId}/story/detail/${task.story_id}\n后端任务：https://www.tapd.cn/tapd_fe/${workspaceId}/task/detail/${task.id}` });
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
    this.snapshots.set(workspaceId, { tasks: workspaceTasks, stories: workspaceStories });
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
      const snapshot = this.snapshots.get(notice.workspace_id);
      // Never deliver stale messages when the current workspace could not be read.
      if (!snapshot) continue;
      const backend = snapshot.tasks.find(task => task.id === taskId);
      const stillAssigned = backend?.story_id && snapshot.stories.some(story => story.id === backend.story_id) &&
        snapshot.tasks.some(front => front.story_id === backend.story_id && front.name.trim().startsWith("前端") &&
          owners(front.owner).includes(notice.owner_name));
      const state = this.deps.db.prepare(`SELECT status, sequence FROM tapd_completion_tasks
        WHERE bot_id = ? AND workspace_id = ? AND task_id = ?`)
        .get(this.botId, notice.workspace_id, taskId) as TaskState | undefined;
      if (!backend?.name.trim().startsWith("后端") || backend.status !== "done" || !stillAssigned ||
        !state || state.status !== "done" || state.sequence !== sequence) {
        this.deps.db.prepare("DELETE FROM tapd_completion_notices WHERE id = ?").run(notice.id);
        continue;
      }
      try {
        // Also repair old-format links in notices queued before this update.
        await this.deps.send(notice.target_id, currentTapdLinks(notice.content));
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
    iterations: listIterations, workItems: getIterationWorkItems,
  });
  console.info("[TAPD通知] 轮询已启用：每天上海时间 09:00～19:00，每 10 分钟检查");
  // Cheap local clock checks; TAPD queries run at most once per ten-minute slot.
  const timer = setInterval(() => { void monitor.tick().catch(() => console.warn("[TAPD通知] 检查失败")); }, 30_000);
  timer.unref();
  return () => { monitor.stop(); clearInterval(timer); };
}
