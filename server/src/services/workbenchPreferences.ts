import { getDatabase } from "./database.js";

export interface WorkbenchPreferences { workspaceId?: string; iterationId?: string }
function store() {
  const db = getDatabase();
  db.exec("CREATE TABLE IF NOT EXISTS workbench_preferences (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, data TEXT NOT NULL)");
  return db;
}
export function getWorkbenchPreferences(userId: string): WorkbenchPreferences {
  const row = store().prepare("SELECT data FROM workbench_preferences WHERE user_id = ?").get(userId) as { data: string } | undefined;
  return row ? JSON.parse(row.data) : {};
}
export function setWorkbenchPreferences(userId: string, data: WorkbenchPreferences): void {
  store().prepare("INSERT INTO workbench_preferences VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data").run(userId, JSON.stringify(data));
}
