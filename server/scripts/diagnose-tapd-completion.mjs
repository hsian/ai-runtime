// Read-only diagnostics: no bot connection, task modification or message delivery.
import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { config, getTapdConfig } from "../dist/config.js";
import { getWecomConfig } from "../dist/modules/wecom/config.js";
import { listIterations, listIterationTasks, listStoryTasks } from "../dist/services/tapd/tapdClient.js";
import { currentMonthIteration, notificationHours } from "../dist/modules/wecom/tapdCompletion.js";

const cfg = getTapdConfig();
const options = getWecomConfig()?.tapdCompletion;
if (!options) throw new Error("通知未启用");
const db = existsSync(config.DATABASE_PATH) ? new Database(config.DATABASE_PATH, { readonly: true }) : undefined;
const tables = new Set(db?.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
const scopes = tables.has("tapd_completion_scopes") ? db.prepare("SELECT workspace_id, iteration_id, cursor FROM tapd_completion_scopes").all() : [];
console.log(JSON.stringify({ database: config.DATABASE_PATH, databaseExists: Boolean(db),
  monitorInitialized: tables.has("tapd_completion_scopes"), inSchedule: notificationHours(new Date()),
  scopes: scopes.map(scope => ({ ...scope, lastPoll: new Date(scope.cursor).toISOString() })),
  pending: tables.has("tapd_completion_notices") ? db.prepare("SELECT workspace_id, owner_name, sent_at FROM tapd_completion_notices").all() : [] }));
const term = process.argv[2] ?? "小迪";
for (const workspaceId of options.workspaceIds) {
  const iterations = (await listIterations(workspaceId, cfg)).filter(iteration => currentMonthIteration(iteration.name, new Date()));
  for (const iteration of iterations) {
    const tasks = await listIterationTasks(iteration.id, { workspaceId }, cfg);
    for (const task of tasks.filter(task => task.name.includes(term))) {
      const siblings = task.story_id && task.story_id !== "0" ? await listStoryTasks(task.story_id, workspaceId, cfg) : [];
      const state = tables.has("tapd_completion_tasks") ? db.prepare("SELECT status, sequence FROM tapd_completion_tasks WHERE workspace_id = ? AND task_id = ?").get(workspaceId, task.id) : undefined;
      console.log(JSON.stringify({ workspaceId, iteration: { id: iteration.id, name: iteration.name },
        task: { id: task.id, name: task.name, status: task.status, completed: task.completed, modified: task.modified,
          story_id: task.story_id, iteration_id: task.iteration_id, owner: task.owner }, state,
        frontends: siblings.filter(front => front.name.trim().startsWith("前端")).map(front => ({
          id: front.id, name: front.name, owner: front.owner, iteration_id: front.iteration_id, story_id: front.story_id,
          matchedOwners: (front.owner ?? "").split(/[;；,，]/).map(name => name.trim()).filter(name => Object.hasOwn(options.recipients, name)),
        })) }));
    }
  }
}
db?.close();
