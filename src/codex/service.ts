import { Codex } from "@openai/codex-sdk";
import type { Thread, RunStreamedResult } from "@openai/codex-sdk";
import type { Config } from "../config/index.js";
import { logger } from "../utils/logger.js";

/**
 * Wraps the Codex SDK, managing thread lifecycle.
 * Each instance holds a reference to the Codex client.
 */
export class CodexService {
  private codex: Codex;
  private config: Config["codex"];
  /** In-memory map: discordThreadId → Codex Thread instance */
  private activeThreads = new Map<string, Thread>();

  constructor(config: Config["codex"]) {
    this.config = config;
    this.codex = new Codex({});
    logger.info("Codex service initialized", { model: config.model });
  }

  /**
   * Create a new Codex thread tied to a project directory.
   * The thread ID is populated after the first `run()` or `runStreamed()`.
   */
  createThread(
    discordThreadId: string,
    workingDirectory: string,
    options?: {
      model?: string;
      approvalMode?: string;
    },
  ): Thread {
    const thread = this.codex.startThread({
      workingDirectory,
      sandboxMode: this.config.sandboxMode as any,
      approvalPolicy: (options?.approvalMode ?? this.config.approvalMode) as any,
      model: options?.model ?? this.config.model,
    });
    this.activeThreads.set(discordThreadId, thread);
    logger.info("Codex thread created", { discordThreadId, workingDirectory });
    return thread;
  }

  /**
   * Resume an existing Codex thread by its persisted ID.
   */
  resumeThread(
    discordThreadId: string,
    codexThreadId: string,
    workingDirectory: string,
    options?: {
      model?: string;
      approvalMode?: string;
    },
  ): Thread {
    const thread = this.codex.resumeThread(codexThreadId, {
      workingDirectory,
      sandboxMode: this.config.sandboxMode as any,
      approvalPolicy: (options?.approvalMode ?? this.config.approvalMode) as any,
      model: options?.model ?? this.config.model,
    });
    this.activeThreads.set(discordThreadId, thread);
    logger.info("Codex thread resumed", { discordThreadId, codexThreadId });
    return thread;
  }

  /**
   * Get or create a thread. If a Codex thread ID exists in DB, resume it.
   */
  getOrCreateThread(
    discordThreadId: string,
    codexThreadId: string | null,
    workingDirectory: string,
    options?: { model?: string; approvalMode?: string },
  ): Thread {
    // Check in-memory cache first
    const existing = this.activeThreads.get(discordThreadId);
    if (existing) {
      return existing;
    }

    if (codexThreadId) {
      return this.resumeThread(discordThreadId, codexThreadId, workingDirectory, options);
    }
    return this.createThread(discordThreadId, workingDirectory, options);
  }

  /**
   * Run a prompt with streaming, returns the event generator.
   */
  async runStreamed(thread: Thread, prompt: string): Promise<RunStreamedResult> {
    return thread.runStreamed(prompt);
  }

  /**
   * Remove thread from in-memory cache.
   */
  removeThread(discordThreadId: string): void {
    this.activeThreads.delete(discordThreadId);
  }

  /**
   * Check if a thread is currently in-memory (active).
   */
  isThreadActive(discordThreadId: string): boolean {
    return this.activeThreads.has(discordThreadId);
  }
}
