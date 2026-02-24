import { getDatabase, saveDatabase } from "./database.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface ProjectRow {
  id: number;
  channel_id: string;
  project_path: string;
  project_name: string;
  model: string | null;
  approval_mode: string | null;
  created_at: string;
}

export interface ThreadRow {
  id: number;
  discord_thread_id: string;
  codex_thread_id: string | null;
  project_id: number;
  thread_name: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: number;
  thread_id: number;
  discord_message_id: string | null;
  direction: "user_to_codex" | "codex_to_discord";
  content: string | null;
  event_type: string | null;
  created_at: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────

/** Run a query that returns rows, mapping columns to an object array */
function queryAll<T>(sql: string, params: any[] = []): T[] {
  const db = getDatabase();
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const results: T[] = [];
  while (stmt.step()) {
    const row = stmt.getAsObject() as T;
    results.push(row);
  }
  stmt.free();
  return results;
}

/** Run a query that returns a single row */
function queryOne<T>(sql: string, params: any[] = []): T | undefined {
  const results = queryAll<T>(sql, params);
  return results[0];
}

/** Run a write query (INSERT, UPDATE, DELETE) */
function execute(sql: string, params: any[] = []): void {
  const db = getDatabase();
  db.run(sql, params);
  saveDatabase();
}

/** Get the last inserted row id */
function lastInsertRowId(): number {
  const db = getDatabase();
  const result = queryOne<{ id: number }>("SELECT last_insert_rowid() as id");
  return result?.id ?? 0;
}

// ─── Project Repository ──────────────────────────────────────────────

export const ProjectRepo = {
  create(
    channelId: string,
    projectPath: string,
    projectName: string,
    model?: string,
    approvalMode?: string,
  ): ProjectRow {
    execute(
      `INSERT INTO projects (channel_id, project_path, project_name, model, approval_mode)
       VALUES (?, ?, ?, ?, ?)`,
      [channelId, projectPath, projectName, model ?? null, approvalMode ?? null],
    );
    // Use getByChannelId instead of lastInsertRowId (unreliable with sql.js save cycle)
    return this.getByChannelId(channelId)!;
  },

  getById(id: number): ProjectRow | undefined {
    return queryOne<ProjectRow>("SELECT * FROM projects WHERE id = ?", [id]);
  },

  getByChannelId(channelId: string): ProjectRow | undefined {
    return queryOne<ProjectRow>("SELECT * FROM projects WHERE channel_id = ?", [channelId]);
  },

  getAll(): ProjectRow[] {
    return queryAll<ProjectRow>("SELECT * FROM projects ORDER BY created_at DESC");
  },

  delete(id: number): void {
    execute("DELETE FROM threads WHERE project_id = ?", [id]);
    execute("DELETE FROM projects WHERE id = ?", [id]);
  },

  deleteByChannelId(channelId: string): void {
    const project = this.getByChannelId(channelId);
    if (project) {
      this.delete(project.id);
    }
  },
};

// ─── Thread Repository ───────────────────────────────────────────────

export const ThreadRepo = {
  create(
    discordThreadId: string,
    projectId: number,
    threadName: string,
    codexThreadId?: string,
  ): ThreadRow {
    execute(
      `INSERT INTO threads (discord_thread_id, codex_thread_id, project_id, thread_name)
       VALUES (?, ?, ?, ?)`,
      [discordThreadId, codexThreadId ?? null, projectId, threadName],
    );
    // Use getByDiscordThreadId instead of lastInsertRowId
    return this.getByDiscordThreadId(discordThreadId)!;
  },

  getById(id: number): ThreadRow | undefined {
    return queryOne<ThreadRow>("SELECT * FROM threads WHERE id = ?", [id]);
  },

  getByDiscordThreadId(discordThreadId: string): ThreadRow | undefined {
    return queryOne<ThreadRow>(
      "SELECT * FROM threads WHERE discord_thread_id = ?",
      [discordThreadId],
    );
  },

  getByProjectId(projectId: number): ThreadRow[] {
    return queryAll<ThreadRow>(
      "SELECT * FROM threads WHERE project_id = ? ORDER BY created_at DESC",
      [projectId],
    );
  },

  updateCodexThreadId(discordThreadId: string, codexThreadId: string): void {
    execute(
      "UPDATE threads SET codex_thread_id = ?, updated_at = CURRENT_TIMESTAMP WHERE discord_thread_id = ?",
      [codexThreadId, discordThreadId],
    );
  },

  updateStatus(discordThreadId: string, status: string): void {
    execute(
      "UPDATE threads SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE discord_thread_id = ?",
      [status, discordThreadId],
    );
  },

  delete(id: number): void {
    execute("DELETE FROM messages WHERE thread_id = ?", [id]);
    execute("DELETE FROM threads WHERE id = ?", [id]);
  },

  getByCodexThreadId(codexThreadId: string): ThreadRow | undefined {
    return queryOne<ThreadRow>(
      "SELECT * FROM threads WHERE codex_thread_id = ?",
      [codexThreadId],
    );
  },
};

// ─── Message Repository ──────────────────────────────────────────────

export const MessageRepo = {
  create(
    threadId: number,
    direction: "user_to_codex" | "codex_to_discord",
    content?: string,
    discordMessageId?: string,
    eventType?: string,
  ): void {
    execute(
      `INSERT INTO messages (thread_id, discord_message_id, direction, content, event_type)
       VALUES (?, ?, ?, ?, ?)`,
      [threadId, discordMessageId ?? null, direction, content ?? null, eventType ?? null],
    );
  },

  getByThreadId(threadId: number, limit = 50): MessageRow[] {
    return queryAll<MessageRow>(
      "SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at DESC LIMIT ?",
      [threadId, limit],
    );
  },
};
