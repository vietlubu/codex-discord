import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { logger } from "../utils/logger.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface CodexSession {
  id: string;
  cwd: string;
  timestamp: string;
  model: string | undefined;
  filePath: string;
}

export interface CodexSessionMessage {
  timestamp: string;
  role: "user" | "assistant" | "developer";
  type: "text" | "function_call" | "function_call_output" | "reasoning" | "other";
  text: string;
}

interface SessionMeta {
  type: "session_meta";
  payload: {
    id: string;
    timestamp: string;
    cwd: string;
    model_provider?: string;
  };
}

interface ResponseItem {
  timestamp: string;
  type: "response_item";
  payload: {
    type: "message" | "function_call" | "function_call_output" | "reasoning";
    role?: "user" | "assistant" | "developer";
    content?: Array<{ type: string; text?: string }>;
    phase?: string;
  };
}

interface TurnContext {
  timestamp: string;
  type: "turn_context";
  payload: {
    model?: string;
  };
}

// ─── Scanner ─────────────────────────────────────────────────────────

const CODEX_HOME = join(homedir(), ".codex");
const SESSIONS_DIR = join(CODEX_HOME, "sessions");
const ARCHIVED_DIR = join(CODEX_HOME, "archived_sessions");

/**
 * Scan all Codex sessions from disk (~/.codex/sessions/ and ~/.codex/archived_sessions/).
 * Returns sessions grouped by their working directory (cwd = project path).
 */
export function scanAllSessions(): Map<string, CodexSession[]> {
  const sessions = new Map<string, CodexSession[]>();

  // Scan active sessions
  const activeFiles = findJsonlFiles(SESSIONS_DIR);
  for (const filePath of activeFiles) {
    const session = parseSessionMeta(filePath);
    if (session) {
      const list = sessions.get(session.cwd) ?? [];
      list.push(session);
      sessions.set(session.cwd, list);
    }
  }

  // Scan archived sessions
  const archivedFiles = findJsonlFiles(ARCHIVED_DIR);
  for (const filePath of archivedFiles) {
    const session = parseSessionMeta(filePath);
    if (session) {
      const list = sessions.get(session.cwd) ?? [];
      list.push(session);
      sessions.set(session.cwd, list);
    }
  }

  // Sort each project's sessions by timestamp (newest first)
  for (const [, list] of sessions) {
    list.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  logger.info("Session scan complete", {
    projects: sessions.size,
    totalSessions: [...sessions.values()].reduce((n, l) => n + l.length, 0),
  });

  return sessions;
}

/**
 * Get all sessions for a specific project directory.
 */
export function getSessionsForProject(projectPath: string): CodexSession[] {
  const allSessions = scanAllSessions();
  return allSessions.get(projectPath) ?? [];
}

/**
 * Parse the messages from a Codex session JSONL file.
 * Only extracts user messages and agent (assistant) messages.
 */
export function parseSessionMessages(filePath: string): CodexSessionMessage[] {
  const messages: CodexSessionMessage[] = [];

  try {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);

        if (parsed.type === "response_item") {
          const item = parsed as ResponseItem;
          const role = item.payload.role;
          const payloadType = item.payload.type;

          // Skip developer/system messages
          if (role === "developer") continue;

          // Extract user messages
          if (role === "user" && payloadType === "message") {
            const texts = (item.payload.content ?? [])
              .filter((c) => c.type === "input_text" && c.text)
              .map((c) => c.text!)
              .join("\n");
            if (texts) {
              messages.push({
                timestamp: item.timestamp,
                role: "user",
                type: "text",
                text: texts,
              });
            }
          }

          // Extract assistant messages (final answers and commentary)
          if (role === "assistant" && payloadType === "message") {
            const texts = (item.payload.content ?? [])
              .filter((c) => c.type === "output_text" && c.text)
              .map((c) => c.text!)
              .join("\n");
            if (texts) {
              messages.push({
                timestamp: item.timestamp,
                role: "assistant",
                type: "text",
                text: texts,
              });
            }
          }

          // Extract reasoning summaries
          if (payloadType === "reasoning") {
            const summaries = (item.payload as any).summary;
            if (Array.isArray(summaries)) {
              const text = summaries
                .filter((s: any) => s.type === "summary_text" && s.text)
                .map((s: any) => s.text)
                .join("\n");
              if (text) {
                messages.push({
                  timestamp: item.timestamp,
                  role: "assistant",
                  type: "reasoning",
                  text,
                });
              }
            }
          }
        }

        // Extract event messages (agent_message type for commentary)
        if (parsed.type === "event_msg" && parsed.payload?.type === "agent_message") {
          messages.push({
            timestamp: parsed.timestamp,
            role: "assistant",
            type: "text",
            text: parsed.payload.message,
          });
        }
      } catch {
        // Skip unparseable lines
      }
    }
  } catch (error) {
    logger.error("Failed to parse session file", { filePath, error });
  }

  return messages;
}

/**
 * Get the display name for a session from its file name.
 * e.g. "rollout-2026-02-24T14-16-49-019c8e81-fea4-7091-9774-4a606a79918f.jsonl"
 * → "2026-02-24 14:16"
 */
export function getSessionDisplayName(session: CodexSession): string {
  const match = basename(session.filePath).match(
    /rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})/,
  );
  if (match) {
    return `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}`;
  }
  return session.id.slice(0, 12);
}

// ─── Internal Helpers ────────────────────────────────────────────────

function parseSessionMeta(filePath: string): CodexSession | null {
  try {
    const content = readFileSync(filePath, "utf-8");
    const firstLine = content.split("\n")[0];
    if (!firstLine) return null;

    const parsed = JSON.parse(firstLine) as SessionMeta;
    if (parsed.type !== "session_meta") return null;

    // Also look for model in turn_context
    let model: string | undefined;
    const lines = content.split("\n");
    for (const line of lines.slice(0, 20)) {
      // Check first 20 lines
      try {
        const obj = JSON.parse(line);
        if (obj.type === "turn_context" && obj.payload?.model) {
          model = obj.payload.model;
          break;
        }
      } catch {
        // skip
      }
    }

    return {
      id: parsed.payload.id,
      cwd: parsed.payload.cwd,
      timestamp: parsed.payload.timestamp,
      model,
      filePath,
    };
  } catch {
    return null;
  }
}

function findJsonlFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    collectJsonlFiles(dir, files, 0, 5);
  } catch {
    // Dir might not exist
  }
  return files;
}

function collectJsonlFiles(
  dir: string,
  files: string[],
  depth: number,
  maxDepth: number,
): void {
  if (depth > maxDepth) return;
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        collectJsonlFiles(fullPath, files, depth + 1, maxDepth);
      } else if (entry.endsWith(".jsonl")) {
        files.push(fullPath);
      }
    }
  } catch {
    // Permission or access error
  }
}
