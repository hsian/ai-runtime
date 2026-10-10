import { getDatabase } from "../../services/database.js";
import type { JobAttachment } from "../../types.js";
import type { ResolvedTapdContext } from "../../services/tapd/resolveContext.js";
import type { WecomSession } from "./types.js";
import { parseTapdUrl } from "../../services/tapd/tapdClient.js";

export interface TapdSnapshot {
  snapshotId: string;
  context: Omit<ResolvedTapdContext, "sourceHtml">;
  attachments: JobAttachment[];
  warnings: string[];
}

export function initTapdStore(): void {
  getDatabase().exec(`CREATE TABLE IF NOT EXISTS wecom_tapd_contexts (
    conversation_id TEXT PRIMARY KEY REFERENCES wecom_topics(conversation_id),
    session_key TEXT NOT NULL REFERENCES wecom_sessions(session_key),
    workspace_id TEXT NOT NULL, item_type TEXT NOT NULL, item_id TEXT NOT NULL, snapshot TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS wecom_tapd_item_idx ON wecom_tapd_contexts(session_key, workspace_id, item_type, item_id);`);
}

export function findTapdTopic(session: WecomSession, workspaceId: string, itemType: string, itemId: string): string | undefined {
  const row = getDatabase().prepare(`SELECT conversation_id FROM wecom_tapd_contexts
    WHERE session_key = ? AND workspace_id = ? AND item_type = ? AND item_id = ?`)
    .get(session.session_key, workspaceId, itemType, itemId) as { conversation_id: string } | undefined;
  return row?.conversation_id;
}

export function getTopicTapd(session: Pick<WecomSession, "session_key" | "conversation_id">): TapdSnapshot | undefined {
  const row = getDatabase().prepare("SELECT snapshot FROM wecom_tapd_contexts WHERE session_key = ? AND conversation_id = ?")
    .get(session.session_key, session.conversation_id) as { snapshot: string } | undefined;
  return row ? JSON.parse(row.snapshot) as TapdSnapshot : undefined;
}

export function saveTopicTapd(session: WecomSession, snapshot: TapdSnapshot): void {
  const context = snapshot.context;
  const itemId = parseTapdUrl(context.url).itemId ?? context.itemId ?? context.storyId;
  getDatabase().prepare(`INSERT INTO wecom_tapd_contexts VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(conversation_id) DO UPDATE SET workspace_id = excluded.workspace_id,
    item_type = excluded.item_type, item_id = excluded.item_id, snapshot = excluded.snapshot`)
    .run(session.conversation_id, session.session_key, context.workspaceId, context.itemType ?? "story",
      itemId, JSON.stringify(snapshot));
  getDatabase().prepare("UPDATE wecom_topics SET title = ?, updated_at = ? WHERE conversation_id = ? AND session_key = ?")
    .run(context.title.slice(0, 120), Date.now(), session.conversation_id, session.session_key);
}
