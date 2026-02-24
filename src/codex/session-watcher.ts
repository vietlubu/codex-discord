import { watch, existsSync, statSync, readFileSync, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseSessionMeta, type CodexSession } from "./session-scanner.js";
import { logger } from "../utils/logger.js";

const SESSIONS_DIR = join(homedir(), ".codex", "sessions");

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

  /** Parsed session meta cache (avoid re-parsing first line) */
  private sessionCache = new Map<string, CodexSession>();

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
    } catch {
      this.fileOffsets.set(filePath, 0);
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

      // Record current size as the offset
      const size = statSync(filePath).size;
      this.fileOffsets.set(filePath, size);
      this.sessionCache.set(filePath, session);

      logger.info("New Codex session detected", {
        id: session.id.slice(0, 12),
        project: session.cwd,
      });

      this.onNewSession(session);
    } else {
      // Existing file modified — read only new bytes
      this.processUpdate(filePath);
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
    if (currentSize <= prevOffset) return;

    // Read only new bytes
    let newContent: string;
    try {
      const fd = require("node:fs").openSync(filePath, "r");
      const buffer = Buffer.alloc(currentSize - prevOffset);
      require("node:fs").readSync(fd, buffer, 0, buffer.length, prevOffset);
      require("node:fs").closeSync(fd);
      newContent = buffer.toString("utf-8");
    } catch {
      return;
    }

    // Update offset
    this.fileOffsets.set(filePath, currentSize);

    // Parse new lines
    const newLines = newContent.split("\n").filter((l) => l.trim());
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
  }
}
