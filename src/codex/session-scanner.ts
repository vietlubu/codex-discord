import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { logger } from "../utils/logger.js";
import { canonicalizeProjectPath } from "../utils/path.js";

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

const INTERNAL_CONTEXT_TAGS = [
  "environment_context",
  "app-context",
  "collaboration_mode",
  "permissions instructions",
];

// ─── Scanner ─────────────────────────────────────────────────────────

const CODEX_HOME = join(homedir(), ".codex");
const SESSIONS_DIR = join(CODEX_HOME, "sessions");
const ARCHIVED_DIR = join(CODEX_HOME, "archived_sessions");

/**
 * Scan all Codex sessions from disk (~/.codex/sessions/ and ~/.codex/archived_sessions/).
 * Returns sessions grouped by their working directory (cwd = project path).
 */
export function scanAllSessions(includeArchived: boolean = false): Map<string, CodexSession[]> {
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

  // Scan archived sessions (only if enabled)
  if (includeArchived) {
    const archivedFiles = findJsonlFiles(ARCHIVED_DIR);
    for (const filePath of archivedFiles) {
      const session = parseSessionMeta(filePath);
      if (session) {
        const list = sessions.get(session.cwd) ?? [];
        list.push(session);
        sessions.set(session.cwd, list);
      }
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
export function getSessionsForProject(projectPath: string, includeArchived: boolean = false): CodexSession[] {
  const allSessions = scanAllSessions(includeArchived);
  return allSessions.get(canonicalizeProjectPath(projectPath)) ?? [];
}

/**
 * Parse the messages from a Codex session JSONL file.
 * Only extracts user messages and agent (assistant) messages.
 */
export function parseSessionMessages(filePath: string): CodexSessionMessage[] {
  const messages: CodexSessionMessage[] = [];
  let lastUserText: string | undefined;
  let lastAssistantText: string | undefined;

  try {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        const timestamp =
          typeof parsed.timestamp === "string" ? parsed.timestamp : "";

        for (const rawUserText of extractUserTextsFromSessionEvent(parsed)) {
          const visibleText = extractVisibleUserMessage(rawUserText);
          if (!visibleText) continue;
          if (visibleText === lastUserText) continue;

          messages.push({
            timestamp,
            role: "user",
            type: "text",
            text: visibleText,
          });
          lastUserText = visibleText;
        }

        for (const assistantText of extractAssistantTextsFromSessionEvent(parsed)) {
          if (assistantText === lastAssistantText) continue;

          messages.push({
            timestamp,
            role: "assistant",
            type: "text",
            text: assistantText,
          });
          lastAssistantText = assistantText;
        }

        if (parsed.type === "response_item") {
          const item = parsed as ResponseItem;
          if (item.payload.type === "reasoning") {
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

/**
 * Get a human-readable title for a session by extracting the first user prompt.
 * Truncates to fit Discord thread name limit (100 chars).
 * Falls back to timestamp-based name if no user message found.
 */
export function getSessionTitle(session: CodexSession): string {
  try {
    const content = readFileSync(session.filePath, "utf-8");
    const lines = content.split("\n");

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        for (const rawUserText of extractUserTextsFromSessionEvent(parsed)) {
          const visibleText = extractVisibleUserMessage(rawUserText);
          if (!visibleText) continue;

          // Clean up and truncate for Discord thread name (max 100 chars)
          const clean = visibleText
            .replace(/\n/g, " ")
            .replace(/\s+/g, " ")
            .trim();
          return clean.length > 95 ? clean.slice(0, 92) + "..." : clean;
        }
      } catch {
        // skip
      }
    }
  } catch {
    // File not readable
  }

  // Fallback to timestamp
  return getSessionDisplayName(session);
}

export function extractVisibleUserMessage(text: string): string | null {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return null;

  if (isAgentsInstructionsMessage(normalized)) return null;
  if (isInternalContextMessage(normalized)) return null;

  return normalized;
}

export function extractUserTextsFromSessionEvent(parsed: any): string[] {
  const texts: string[] = [];

  if (
    parsed?.type === "response_item" &&
    parsed.payload?.role === "user" &&
    parsed.payload?.type === "message"
  ) {
    for (const item of parsed.payload.content ?? []) {
      if (item?.type !== "input_text") continue;
      const text = coerceText(item?.text ?? item?.value ?? item?.message);
      if (text) texts.push(text);
    }
  }

  if (parsed?.type === "event_msg" && parsed.payload?.type === "user_message") {
    const direct = coerceText(parsed.payload?.message);
    if (direct) texts.push(direct);

    if (Array.isArray(parsed.payload?.text_elements)) {
      for (const item of parsed.payload.text_elements) {
        const text = coerceText(item?.text ?? item?.value ?? item);
        if (text) texts.push(text);
      }
    }
  }

  return uniqueTexts(texts);
}

export function extractAssistantTextsFromSessionEvent(parsed: any): string[] {
  const texts: string[] = [];

  if (
    parsed?.type === "response_item" &&
    parsed.payload?.role === "assistant" &&
    parsed.payload?.type === "message"
  ) {
    for (const item of parsed.payload.content ?? []) {
      if (item?.type !== "output_text" && item?.type !== "text") continue;
      const text = coerceText(item?.text ?? item?.value ?? item?.message);
      if (text) texts.push(text);
    }
  }

  if (parsed?.type === "event_msg" && parsed.payload?.type === "agent_message") {
    const direct = coerceText(parsed.payload?.message);
    if (direct) texts.push(direct);

    if (Array.isArray(parsed.payload?.text_elements)) {
      for (const item of parsed.payload.text_elements) {
        const text = coerceText(item?.text ?? item?.value ?? item);
        if (text) texts.push(text);
      }
    }
  }

  if (parsed?.type === "event_msg" && parsed.payload?.type === "task_complete") {
    const finalMessage = coerceText(parsed.payload?.last_agent_message);
    if (finalMessage) texts.push(finalMessage);
  }

  return uniqueTexts(texts);
}

function isAgentsInstructionsMessage(text: string): boolean {
  const openTag = "<INSTRUCTIONS>";
  const closeTag = "</INSTRUCTIONS>";
  const openIndex = text.indexOf(openTag);
  const closeIndex = text.lastIndexOf(closeTag);
  if (openIndex === -1 || closeIndex === -1 || closeIndex <= openIndex) {
    return false;
  }

  const header = text.slice(0, openIndex).trim();
  const tail = text.slice(closeIndex + closeTag.length).trim();
  if (tail.length > 0) return false;

  const headerLines = header
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (headerLines.length !== 1) return false;

  return /^#?\s*AGENTS\.md instructions for\s+/i.test(headerLines[0]);
}

function isInternalContextMessage(text: string): boolean {
  return INTERNAL_CONTEXT_TAGS.some((tag) => {
    const openTag = `<${tag}>`;
    const closeTag = `</${tag}>`;
    return text.startsWith(openTag) && text.endsWith(closeTag);
  });
}

function coerceText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  return normalized.length > 0 ? normalized : null;
}

function uniqueTexts(texts: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const text of texts) {
    if (seen.has(text)) continue;
    seen.add(text);
    unique.push(text);
  }

  return unique;
}

// ─── Internal Helpers ────────────────────────────────────────────────

export function parseSessionMeta(filePath: string): CodexSession | null {
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
      cwd: canonicalizeProjectPath(parsed.payload.cwd),
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
