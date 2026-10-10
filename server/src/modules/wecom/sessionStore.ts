import { randomUUID } from "node:crypto";
import { getDatabase } from "../../services/database.js";
import type { WecomSession, WecomJobBinding, WecomNotice } from "./types.js";
import { ensureTopic, initTopicStore, rememberTopicJob } from "./topicStore.js";
import { initTapdStore } from "./tapdStore.js";
import { initDialogueStore, rememberChoices } from "./dialogueStore.js";

export function initWecomStore(): void {
  getDatabase().exec(`
    CREATE TABLE IF NOT EXISTS wecom_sessions (
      session_key TEXT PRIMARY KEY, owner_id TEXT NOT NULL, target_id TEXT NOT NULL,
      user_id TEXT NOT NULL, conversation_id TEXT NOT NULL, active_job_id TEXT
    );
    CREATE TABLE IF NOT EXISTS wecom_messages (
      message_key TEXT PRIMARY KEY, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS wecom_chat_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_key TEXT NOT NULL REFERENCES wecom_sessions(session_key),
      conversation_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS wecom_chat_history_session_idx
      ON wecom_chat_history(session_key, conversation_id, id);
    CREATE TABLE IF NOT EXISTS wecom_job_bindings (
      job_id TEXT PRIMARY KEY REFERENCES jobs(job_id) ON DELETE CASCADE,
      session_key TEXT NOT NULL REFERENCES wecom_sessions(session_key),
      target_id TEXT NOT NULL, user_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS wecom_notices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
      signature TEXT NOT NULL, target_id TEXT NOT NULL, chunks TEXT NOT NULL,
      sent_chunks INTEGER NOT NULL DEFAULT 0, delivered INTEGER NOT NULL DEFAULT 0,
      UNIQUE(job_id, signature)
    );
    CREATE TABLE IF NOT EXISTS wecom_silent_jobs (
      job_id TEXT PRIMARY KEY REFERENCES jobs(job_id) ON DELETE CASCADE
    );
  `);
  initTopicStore();
  initTapdStore();
  initDialogueStore();
  getDatabase().prepare("DELETE FROM wecom_messages WHERE created_at < ?")
    .run(Date.now() - 7 * 86400_000);
}

export function getSession(botId: string, targetId: string, userId: string, projectId: string): WecomSession {
  const key = JSON.stringify([botId, targetId, userId, projectId]);
  const db = getDatabase();
  db.prepare(`INSERT OR IGNORE INTO wecom_sessions
    (session_key, owner_id, target_id, user_id, conversation_id) VALUES (?, ?, ?, ?, ?)`)
    .run(key, `wecom:${botId}:${userId}`, targetId, userId, randomUUID());
  const session = db.prepare("SELECT * FROM wecom_sessions WHERE session_key = ?").get(key) as WecomSession;
  ensureTopic(session);
  return session;
}

export function hasMessage(key: string): boolean {
  return Boolean(getDatabase().prepare("SELECT 1 FROM wecom_messages WHERE message_key = ?").get(key));
}

export function rememberMessage(key: string): void {
  getDatabase().prepare("INSERT OR IGNORE INTO wecom_messages VALUES (?, ?)").run(key, Date.now());
}

export function bindJob(session: WecomSession, jobId: string, activate = true): void {
  getDatabase().prepare("INSERT INTO wecom_job_bindings VALUES (?, ?, ?, ?)")
    .run(jobId, session.session_key, session.target_id, session.user_id);
  if (activate) getDatabase().prepare("UPDATE wecom_sessions SET active_job_id = ? WHERE session_key = ?")
    .run(jobId, session.session_key);
  rememberTopicJob(session, jobId, activate);
}

export function resetSession(session: WecomSession): void {
  getDatabase().prepare("UPDATE wecom_topics SET archived = 1 WHERE session_key = ?").run(session.session_key);
  getDatabase().prepare("UPDATE wecom_sessions SET conversation_id = ?, active_job_id = NULL WHERE session_key = ?")
    .run(randomUUID(), session.session_key);
  const fresh = getDatabase().prepare("SELECT * FROM wecom_sessions WHERE session_key = ?").get(session.session_key) as WecomSession;
  ensureTopic(fresh);
}

export function getChatHistory(session: WecomSession): { role: "user" | "assistant"; content: string }[] {
  return (getDatabase().prepare(`SELECT role, content FROM wecom_chat_history
    WHERE session_key = ? AND conversation_id = ? ORDER BY id DESC LIMIT 12`)
    .all(session.session_key, session.conversation_id) as { role: "user" | "assistant"; content: string }[]).reverse();
}

export function recordChatExchange(session: WecomSession, user: string, assistant?: string): void {
  const db = getDatabase();
  db.transaction(() => {
    const insert = db.prepare("INSERT INTO wecom_chat_history (session_key, conversation_id, role, content) VALUES (?, ?, ?, ?)");
    insert.run(session.session_key, session.conversation_id, "user", user.slice(0, 2000));
    if (assistant) insert.run(session.session_key, session.conversation_id, "assistant", assistant.slice(0, 2000));
    db.prepare(`DELETE FROM wecom_chat_history WHERE session_key = ? AND conversation_id = ? AND id NOT IN
      (SELECT id FROM wecom_chat_history WHERE session_key = ? AND conversation_id = ? ORDER BY id DESC LIMIT 12)`)
      .run(session.session_key, session.conversation_id, session.session_key, session.conversation_id);
  })();
  if (assistant) rememberChoices(session, assistant);
}

export function recordFinalAnswer(jobId: string, answer: string): void {
  const row = getDatabase().prepare(`SELECT s.*, j.conversation_id FROM wecom_sessions s
    JOIN wecom_job_bindings b ON b.session_key = s.session_key
    JOIN jobs j ON j.job_id = b.job_id WHERE b.job_id = ?`).get(jobId) as WecomSession | undefined;
  if (!row?.conversation_id) return;
  getDatabase().prepare("INSERT INTO wecom_chat_history (session_key, conversation_id, role, content) VALUES (?, ?, 'assistant', ?)")
    .run(row.session_key, row.conversation_id, answer.length > 6000 ? answer.slice(0, 2000) + "\n...\n" + answer.slice(-4000) : answer);
  getDatabase().prepare(`DELETE FROM wecom_chat_history WHERE session_key = ? AND conversation_id = ? AND id NOT IN
    (SELECT id FROM wecom_chat_history WHERE session_key = ? AND conversation_id = ? ORDER BY id DESC LIMIT 12)`)
    .run(row.session_key, row.conversation_id, row.session_key, row.conversation_id);
  rememberChoices(row, answer);
}

export function getBinding(jobId: string, sessionKey: string): WecomJobBinding | undefined {
  return getDatabase().prepare("SELECT * FROM wecom_job_bindings WHERE job_id = ? AND session_key = ?")
    .get(jobId, sessionKey) as WecomJobBinding | undefined;
}

export function listBindings(): WecomJobBinding[] {
  return getDatabase().prepare("SELECT * FROM wecom_job_bindings").all() as WecomJobBinding[];
}

export function queueNotice(jobId: string, signature: string, targetId: string, chunks: string[]): void {
  if (areJobNoticesSilent(jobId)) return;
  getDatabase().prepare(`INSERT OR IGNORE INTO wecom_notices (job_id, signature, target_id, chunks)
    VALUES (?, ?, ?, ?)`).run(jobId, signature, targetId, JSON.stringify(chunks));
}

export function areJobNoticesSilent(jobId: string): boolean {
  return Boolean(getDatabase().prepare("SELECT 1 FROM wecom_silent_jobs WHERE job_id = ?").get(jobId));
}

export function silenceJobNotices(jobId: string): void {
  getDatabase().transaction(() => {
    getDatabase().prepare("INSERT OR IGNORE INTO wecom_silent_jobs VALUES (?)").run(jobId);
    getDatabase().prepare("UPDATE wecom_notices SET delivered = 1 WHERE job_id = ? AND delivered = 0").run(jobId);
  })();
}

export function pendingNotices(): WecomNotice[] {
  return getDatabase().prepare("SELECT * FROM wecom_notices WHERE delivered = 0 ORDER BY id LIMIT 100")
    .all() as WecomNotice[];
}

export function acknowledgeChunk(id: number, sent: number, total: number): void {
  getDatabase().prepare("UPDATE wecom_notices SET sent_chunks = ?, delivered = ? WHERE id = ?")
    .run(sent, sent === total ? 1 : 0, id);
}
