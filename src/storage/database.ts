import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { logger } from "../utils/logger.js";
import { canonicalizeProjectPath } from "../utils/path.js";

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

  migrateCanonicalProjectPaths(db);
  dedupeCodexThreadMappings(db);
  createIndexes(db);
}

function migrateCanonicalProjectPaths(db: SqlJsDatabase): void {
  const projects = queryRows<{ id: number; project_path: string }>(
    db,
    "SELECT id, project_path FROM projects ORDER BY id ASC",
  );

  const keepByCanonicalPath = new Map<string, number>();

  for (const project of projects) {
    const canonicalPath = canonicalizeProjectPath(project.project_path);
    const keepId = keepByCanonicalPath.get(canonicalPath);

    if (!keepId) {
      keepByCanonicalPath.set(canonicalPath, project.id);

      if (project.project_path !== canonicalPath) {
        db.run("UPDATE projects SET project_path = ? WHERE id = ?", [
          canonicalPath,
          project.id,
        ]);
      }
      continue;
    }

    db.run("UPDATE threads SET project_id = ? WHERE project_id = ?", [
      keepId,
      project.id,
    ]);
    db.run("DELETE FROM projects WHERE id = ?", [project.id]);

    logger.warn("Merged duplicate project rows", {
      keepProjectId: keepId,
      mergedProjectId: project.id,
      canonicalPath,
    });
  }
}

function dedupeCodexThreadMappings(db: SqlJsDatabase): void {
  const threads = queryRows<{ id: number; codex_thread_id: string }>(
    db,
    "SELECT id, codex_thread_id FROM threads WHERE codex_thread_id IS NOT NULL ORDER BY id ASC",
  );

  const keepByCodexThreadId = new Map<string, number>();

  for (const thread of threads) {
    const keepId = keepByCodexThreadId.get(thread.codex_thread_id);

    if (!keepId) {
      keepByCodexThreadId.set(thread.codex_thread_id, thread.id);
      continue;
    }

    db.run("UPDATE messages SET thread_id = ? WHERE thread_id = ?", [
      keepId,
      thread.id,
    ]);
    db.run("DELETE FROM threads WHERE id = ?", [thread.id]);

    logger.warn("Merged duplicate thread rows", {
      keepThreadId: keepId,
      mergedThreadId: thread.id,
      codexThreadId: thread.codex_thread_id.slice(0, 12),
    });
  }
}

function createIndexes(db: SqlJsDatabase): void {
  runIndex(db, "CREATE INDEX IF NOT EXISTS idx_threads_project ON threads(project_id);");
  runIndex(db, "CREATE INDEX IF NOT EXISTS idx_threads_discord ON threads(discord_thread_id);");
  runIndex(db, "CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);");
  runIndex(db, "CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_project_path_unique ON projects(project_path);");
  runIndex(db, "CREATE UNIQUE INDEX IF NOT EXISTS idx_threads_codex_thread_unique ON threads(codex_thread_id);");
}

function runIndex(db: SqlJsDatabase, sql: string): void {
  try {
    db.run(sql);
  } catch (error) {
    logger.warn("Index migration skipped", {
      sql,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function queryRows<T extends Record<string, unknown>>(db: SqlJsDatabase, sql: string): T[] {
  const result = db.exec(sql);
  if (result.length === 0) return [];

  const [first] = result;
  return first.values.map((valueRow: unknown[]) => {
    const row: Record<string, unknown> = {};
    for (let i = 0; i < first.columns.length; i++) {
      row[first.columns[i]] = valueRow[i];
    }
    return row as T;
  });
}
