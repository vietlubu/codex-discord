import { watch, existsSync, statSync, openSync, readSync, closeSync, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseSessionMeta, type CodexSession } from "./session-scanner.js";
import { logger } from "../utils/logger.js";

const SESSIONS_DIR = join(homedir(), ".codex", "sessions");
const FOLLOW_UP_POLL_INTERVAL_MS = 3_000;
const FOLLOW_UP_WINDOW_MS = 6 * 60 * 60 * 1000; // 6 hours

/** A new session file appeared */
export type NewSessionHandler = (session: CodexSession) => void;

/** New lines appended to an existing session file */
export type SessionUpdateHandler = (session: CodexSession, newLines: string[]) => void;

/**
 * Watches ~/.codex/sessions/ for:
 *  1. New JSONL session files → calls onNewSession
 *  2. Modifications to existing files (appended lines) → calls onSessionUpdate
 *
 * Uses fs.watch with recursive: true (FSEvents on macOS = lightweight).
 * Tracks byte offsets per file to efficiently read only new content.
 */
export class SessionWatcher {
  private watcher: FSWatcher | null = null;
  private onNewSession: NewSessionHandler;
  private onSessionUpdate: SessionUpdateHandler;

  /** Track known files and their last-read byte offset */
  private fileOffsets = new Map<string, number>();

  /** Debounce timers per file path */
  private pending = new Map<string, NodeJS.Timeout>();
  /** Fallback polling timers to cover missed fs.watch append events. */
  private followUpPollers = new Map<string, NodeJS.Timeout>();
  /** Polling deadline per file path (epoch ms). */
  private followUpDeadlines = new Map<string, number>();

  /** Parsed session meta cache (avoid re-parsing first line) */
  private sessionCache = new Map<string, CodexSession>();
  /** Trailing partial line per file (when read chunk ends mid-JSON line). */
  private partialLines = new Map<string, string>();

  constructor(onNewSession: NewSessionHandler, onSessionUpdate: SessionUpdateHandler) {
    this.onNewSession = onNewSession;
    this.onSessionUpdate = onSessionUpdate;
  }

  /**
   * Mark a file as already known (from initial sync).
   * Records its current byte size so only future appends are processed.
   */
  markSeen(filePath: string): void {
    try {
      const size = statSync(filePath).size;
      this.fileOffsets.set(filePath, size);
      this.partialLines.delete(filePath);
    } catch {
      this.fileOffsets.set(filePath, 0);
      this.partialLines.delete(filePath);
    }
  }

  start(): void {
    if (!existsSync(SESSIONS_DIR)) {
      logger.warn("Codex sessions directory not found, watcher not started", {
        path: SESSIONS_DIR,
      });
      return;
    }

    try {
      this.watcher = watch(SESSIONS_DIR, { recursive: true }, (_eventType, filename) => {
        if (!filename || !filename.endsWith(".jsonl")) return;
        const fullPath = join(SESSIONS_DIR, filename);
        this.scheduleProcess(fullPath);
      });

      logger.info("Session watcher started", { path: SESSIONS_DIR });
    } catch (error) {
      logger.error("Failed to start session watcher", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    for (const timeout of this.pending.values()) {
      clearTimeout(timeout);
    }
    this.pending.clear();
    for (const timeout of this.followUpPollers.values()) {
      clearTimeout(timeout);
    }
    this.followUpPollers.clear();
    this.followUpDeadlines.clear();
    this.partialLines.clear();
    logger.info("Session watcher stopped");
  }

  /**
   * Debounce file processing — wait 1.5s after last change event
   * to let Codex finish writing before we read.
   */
  private scheduleProcess(filePath: string): void {
    const existing = this.pending.get(filePath);
    if (existing) clearTimeout(existing);

    this.pending.set(
      filePath,
      setTimeout(() => {
        this.pending.delete(filePath);
        this.processFile(filePath);
      }, 1500),
    );
  }

  private processFile(filePath: string): void {
    if (!existsSync(filePath)) return;

    const isNew = !this.fileOffsets.has(filePath);

    if (isNew) {
      // Brand new file — parse session meta and notify
      const session = parseSessionMeta(filePath);
      if (!session) return;

      // Start at 0 so we can replay the file's current content once
      // (messages can already exist by the time the new-file event arrives).
      this.fileOffsets.set(filePath, 0);
      this.sessionCache.set(filePath, session);

      logger.info("New Codex session detected", {
        id: session.id.slice(0, 12),
        project: session.cwd,
      });

      this.onNewSession(session);

      // Emit the file's current lines immediately.
      // The consumer may buffer these until thread mapping is ready.
      this.processUpdate(filePath);
      this.extendFollowUpPolling(filePath);
    } else {
      // Existing file modified — read only new bytes
      this.processUpdate(filePath);
      this.extendFollowUpPolling(filePath);
    }
  }

  private processUpdate(filePath: string): void {
    const prevOffset = this.fileOffsets.get(filePath) ?? 0;

    let currentSize: number;
    try {
      currentSize = statSync(filePath).size;
    } catch {
      return;
    }

    // No new data
    if (currentSize <= prevOffset) {
      // File was truncated or rewritten: reset state and replay from start.
      if (currentSize < prevOffset) {
        this.fileOffsets.set(filePath, 0);
        this.partialLines.delete(filePath);
        this.processUpdate(filePath);
      }
      return;
    }

    // Read only new bytes
    let newContent: string;
    try {
      const fd = openSync(filePath, "r");
      const buffer = Buffer.alloc(currentSize - prevOffset);
      readSync(fd, buffer, 0, buffer.length, prevOffset);
      closeSync(fd);
      newContent = buffer.toString("utf-8");
    } catch {
      return;
    }

    // Update offset
    this.fileOffsets.set(filePath, currentSize);

    // Parse new lines while preserving a trailing partial line for next update.
    const previousPartial = this.partialLines.get(filePath) ?? "";
    const combined = previousPartial + newContent;
    const parts = combined.split("\n");

    let trailingPartial = "";
    if (!combined.endsWith("\n")) {
      trailingPartial = parts.pop() ?? "";
    }

    if (trailingPartial) {
      // Some writers do not end the last JSONL record with '\n'.
      // If the trailing chunk is already valid JSON, emit it now.
      try {
        JSON.parse(trailingPartial);
        parts.push(trailingPartial);
        trailingPartial = "";
      } catch {
        // Keep incomplete line for the next append.
      }
    }

    if (trailingPartial) this.partialLines.set(filePath, trailingPartial);
    else this.partialLines.delete(filePath);

    const newLines = parts.filter((l) => l.trim());
    if (newLines.length === 0) return;

    // Get cached session meta (or re-parse if needed)
    let session = this.sessionCache.get(filePath);
    if (!session) {
      session = parseSessionMeta(filePath) ?? undefined;
      if (!session) return;
      this.sessionCache.set(filePath, session);
    }

    logger.debug("Session file updated", {
      session: session.id.slice(0, 12),
      newLines: newLines.length,
    });

    this.onSessionUpdate(session, newLines);

    // Keep a short tail-polling window for this file because fs.watch may
    // miss some append events on macOS in burst writes.
    this.extendFollowUpPolling(filePath);
  }

  private extendFollowUpPolling(filePath: string): void {
    const until = Date.now() + FOLLOW_UP_WINDOW_MS;
    const existingDeadline = this.followUpDeadlines.get(filePath) ?? 0;
    this.followUpDeadlines.set(filePath, Math.max(existingDeadline, until));

    if (this.followUpPollers.has(filePath)) return;

    const tick = () => {
      const deadline = this.followUpDeadlines.get(filePath) ?? 0;
      if (Date.now() > deadline || !existsSync(filePath)) {
        this.followUpDeadlines.delete(filePath);
        this.followUpPollers.delete(filePath);
        return;
      }

      this.processUpdate(filePath);

      const timer = setTimeout(tick, FOLLOW_UP_POLL_INTERVAL_MS);
      this.followUpPollers.set(filePath, timer);
    };

    const timer = setTimeout(tick, FOLLOW_UP_POLL_INTERVAL_MS);
    this.followUpPollers.set(filePath, timer);
  }
}
