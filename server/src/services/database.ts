import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import { config } from "../config.js";

let database: Database.Database | undefined;

export function initDatabase(): Database.Database {
  if (database) return database;

  mkdirSync(dirname(config.DATABASE_PATH), { recursive: true });
  database = new Database(config.DATABASE_PATH);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  database.pragma("auto_vacuum = INCREMENTAL");

  database.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      job_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      conversation_id TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      data TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS jobs_owner_created_idx
      ON jobs(owner_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS jobs_conversation_idx
      ON jobs(owner_id, conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS jobs_status_updated_idx
      ON jobs(status, updated_at);

    CREATE TABLE IF NOT EXISTS job_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      job_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      data TEXT NOT NULL,
      FOREIGN KEY(job_id) REFERENCES jobs(job_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS job_events_job_sequence_idx
      ON job_events(job_id, sequence);
  `);

  return database;
}

export function getDatabase(): Database.Database {
  return database ?? initDatabase();
}

export function closeDatabase(): void {
  if (!database) return;
  database.close();
  database = undefined;
}
