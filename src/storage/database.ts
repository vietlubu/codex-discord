import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { logger } from "../utils/logger.js";

let db: SqlJsDatabase;
let dbPath: string;

export async function initDatabase(path: string): Promise<SqlJsDatabase> {
  dbPath = path;
  mkdirSync(dirname(path), { recursive: true });

  const SQL = await initSqlJs();

  if (existsSync(path)) {
    const buffer = readFileSync(path);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.run("PRAGMA foreign_keys = ON;");
  runMigrations(db);
  saveDatabase();

  logger.info("Database initialized", { path });
  return db;
}

export function getDatabase(): SqlJsDatabase {
  if (!db) {
    throw new Error("Database not initialized. Call initDatabase() first.");
  }
  return db;
}

/** Persist the in-memory database to disk */
export function saveDatabase(): void {
  if (!db || !dbPath) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  writeFileSync(dbPath, buffer);
}

function runMigrations(db: SqlJsDatabase): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT UNIQUE NOT NULL,
      project_path TEXT NOT NULL,
      project_name TEXT NOT NULL,
      model TEXT,
      approval_mode TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_thread_id TEXT UNIQUE NOT NULL,
      codex_thread_id TEXT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      thread_name TEXT NOT NULL,
      status TEXT DEFAULT 'active' CHECK(status IN ('active', 'completed', 'error')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      discord_message_id TEXT,
      direction TEXT NOT NULL CHECK(direction IN ('user_to_codex', 'codex_to_discord')),
      content TEXT,
      event_type TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Create indexes (ignore if exist)
  try {
    db.run("CREATE INDEX IF NOT EXISTS idx_threads_project ON threads(project_id);");
    db.run("CREATE INDEX IF NOT EXISTS idx_threads_discord ON threads(discord_thread_id);");
    db.run("CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);");
  } catch {
    // Indexes may already exist
  }
}
