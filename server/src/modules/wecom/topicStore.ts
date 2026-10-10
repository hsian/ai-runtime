import { randomUUID } from "node:crypto";
import { getDatabase } from "../../services/database.js";
import { getJob } from "../../services/jobStore.js";
import type { WecomSession } from "./types.js";
import { getTopicTapd } from "./tapdStore.js";

interface TopicRow {
  conversation_id: string;
  session_key: string;
  title: string;
  active_job_id: string | null;
  last_job_id: string | null;
  updated_at: number;
}

export function initTopicStore(): void {
  getDatabase().exec(`CREATE TABLE IF NOT EXISTS wecom_topics (
    conversation_id TEXT PRIMARY KEY, session_key TEXT NOT NULL REFERENCES wecom_sessions(session_key),
    title TEXT NOT NULL DEFAULT '', active_job_id TEXT, last_job_id TEXT, updated_at INTEGER NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS wecom_topics_session_idx ON wecom_topics(session_key, updated_at);`);
  const columns = getDatabase().prepare("PRAGMA table_info(wecom_topics)").all() as { name: string }[];
  if (!columns.some(column => column.name === "archived")) {
    getDatabase().exec("ALTER TABLE wecom_topics ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
  }
  getDatabase().prepare(`INSERT OR IGNORE INTO wecom_topics
    (conversation_id, session_key, active_job_id, last_job_id, updated_at)
    SELECT conversation_id, session_key, active_job_id, active_job_id, ? FROM wecom_sessions`).run(Date.now());
}

export function ensureTopic(session: WecomSession): void {
  getDatabase().prepare(`INSERT OR IGNORE INTO wecom_topics
    (conversation_id, session_key, active_job_id, last_job_id, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .run(session.conversation_id, session.session_key, session.active_job_id, session.active_job_id, Date.now());
}

export function selectTopic(session: WecomSession, id: string, title = ""): void {
  const db = getDatabase();
  db.transaction(() => {
    if (id === "new") {
      id = randomUUID();
      db.prepare(`INSERT INTO wecom_topics (conversation_id, session_key, title, updated_at) VALUES (?, ?, ?, ?)`)
        .run(id, session.session_key, title.slice(0, 120), Date.now());
    }
    const topic = db.prepare("SELECT * FROM wecom_topics WHERE conversation_id = ? AND session_key = ?")
      .get(id, session.session_key) as TopicRow | undefined;
    if (!topic) throw new Error("这个话题不属于当前会话，请重新描述问题。");
    db.prepare("UPDATE wecom_sessions SET conversation_id = ?, active_job_id = ? WHERE session_key = ?")
      .run(id, topic.active_job_id, session.session_key);
    db.prepare("UPDATE wecom_topics SET updated_at = ?, archived = 0 WHERE conversation_id = ?").run(Date.now(), id);
    session.conversation_id = id;
    session.active_job_id = topic.active_job_id;
  })();
}

export function rememberTopicJob(session: WecomSession, jobId: string, activate: boolean): void {
  ensureTopic(session);
  const job = getJob(jobId);
  getDatabase().prepare(`UPDATE wecom_topics SET last_job_id = ?,
    active_job_id = CASE WHEN ? THEN ? ELSE active_job_id END,
    title = CASE WHEN title = '' THEN ? ELSE title END, updated_at = ?
    WHERE conversation_id = ? AND session_key = ?`)
    .run(jobId, activate ? 1 : 0, jobId, job?.prompt.slice(0, 120) ?? "", Date.now(), session.conversation_id, session.session_key);
}

export function listTopics(session: WecomSession) {
  ensureTopic(session);
  const rows = getDatabase().prepare("SELECT * FROM wecom_topics WHERE session_key = ? AND archived = 0 ORDER BY updated_at DESC")
    .all(session.session_key) as TopicRow[];
  return rows.map(topic => {
    const active = topic.active_job_id ? getJob(topic.active_job_id) : undefined;
    const last = topic.last_job_id ? getJob(topic.last_job_id) : undefined;
    const tapd = getTopicTapd({ session_key: session.session_key, conversation_id: topic.conversation_id });
    return { id: topic.conversation_id, title: topic.title || active?.prompt.slice(0, 120) || "新话题",
      current: topic.conversation_id === session.conversation_id,
      tapd: tapd ? { title: tapd.context.title, itemType: tapd.context.itemType, itemId: tapd.context.itemId,
        description: tapd.context.description.slice(0, 1200), warnings: tapd.warnings } : undefined,
      activeTask: active?.ownerId === session.owner_id ? {
        jobId: active.jobId, status: active.status, prompt: active.prompt.slice(0, 1200),
        plan: active.planSummary?.slice(0, 1200), questions: active.clarificationQuestions,
      } : undefined,
      result: last?.ownerId === session.owner_id && ["completed", "awaiting_merge"].includes(last.status)
        ? (last.implementationSummary || last.message)?.slice(0, 2000) : undefined };
  });
}

export function topicCandidates(session: WecomSession) {
  const topics = listTopics(session);
  const important = topics.filter(topic => topic.current || (topic.activeTask
    && !["completed", "failed", "cancelled"].includes(topic.activeTask.status)));
  return [...important.sort((a, b) => Number(b.current) - Number(a.current)),
    ...topics.filter(topic => !important.includes(topic)).slice(0, 8)].slice(0, 12);
}
