import type { SendableChannels, Message } from "discord.js";
import type { ThreadEvent } from "@openai/codex-sdk";
import type { VerboseLevel } from "../config/index.js";
import { CodexService } from "../codex/service.js";
import { EventFormatter, type FormattedMessage } from "../codex/event-formatter.js";
import { ThreadRepo, ProjectRepo, MessageRepo } from "../storage/repositories.js";
import { logger } from "../utils/logger.js";

/**
 * Manages the bidirectional message sync between Discord threads and Codex threads.
 * Handles sending user messages to Codex and streaming Codex responses back.
 */
export class MessageSync {
  private codexService: CodexService;
  private formatter: EventFormatter;

  /** Track which discord threads are currently processing a Codex turn */
  private processing = new Set<string>();
  /** Short-lived dedupe cache to suppress watcher echoes of Discord-origin turns. */
  private recentWatcherEchoes = new Map<
    string,
    { expiresAt: number; user: Set<string>; assistant: Set<string> }
  >();
  private static readonly WATCHER_ECHO_TTL_MS = 8_000;

  constructor(codexService: CodexService, verboseLevel: VerboseLevel = 1) {
    this.codexService = codexService;
    this.formatter = new EventFormatter(verboseLevel);
  }

  /**
   * Handle a user message from Discord → send to Codex → stream response back.
   */
  async handleUserMessage(message: Message): Promise<void> {
    const discordThreadId = message.channel.id;
    const prompt = message.content;

    if (!prompt.trim()) return;
    this.pruneExpiredWatcherEchoes();

    // Check if already processing
    if (this.processing.has(discordThreadId)) {
      await message.reply("⏳ A previous request is still processing. Please wait.");
      return;
    }

    // Look up thread mapping
    const threadRow = ThreadRepo.getByDiscordThreadId(discordThreadId);
    if (!threadRow) {
      logger.warn("No thread mapping found", { discordThreadId });
      return;
    }

    const project = ProjectRepo.getById(threadRow.project_id);
    if (!project) {
      logger.error("Project not found for thread", { threadRow });
      return;
    }

    // Log user message
    MessageRepo.create(threadRow.id, "user_to_codex", prompt, message.id);
    this.startWatcherEchoSuppression(discordThreadId, prompt);

    this.processing.add(discordThreadId);

    try {
      // Get or create Codex thread
      const codexThread = this.codexService.getOrCreateThread(
        discordThreadId,
        threadRow.codex_thread_id,
        project.project_path,
        {
          model: project.model ?? undefined,
          approvalMode: project.approval_mode ?? undefined,
        },
      );

      // Stream response
      await this.streamCodexResponse(
        message.channel as SendableChannels,
        codexThread,
        threadRow,
        prompt,
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error("Error processing message", { error: errorMsg, discordThreadId });
      await (message.channel as SendableChannels)
        .send(`❌ **Error:** ${errorMsg.slice(0, 500)}`)
        .catch(() => {});
      ThreadRepo.updateStatus(discordThreadId, "error");
    } finally {
      this.processing.delete(discordThreadId);
      this.extendWatcherEchoSuppression(discordThreadId);
    }
  }

  private async streamCodexResponse(
    channel: SendableChannels,
    codexThread: any, // Thread from SDK
    threadRow: any,
    prompt: string,
  ): Promise<void> {
    const { events } = await this.codexService.runStreamed(codexThread, prompt);

    let transientMessage: Message | null = null;

    for await (const event of events) {
      if (event.type === "item.completed" && event.item.type === "agent_message") {
        this.rememberWatcherAssistantEcho(threadRow.discord_thread_id, event.item.text);
      }

      // Capture thread ID on first event
      if (event.type === "thread.started") {
        if (!threadRow.codex_thread_id) {
          ThreadRepo.updateCodexThreadId(
            threadRow.discord_thread_id,
            event.thread_id,
          );
          logger.info("Codex thread ID captured", {
            discordThreadId: threadRow.discord_thread_id,
            codexThreadId: event.thread_id,
          });
        }
        continue;
      }

      const formatted = this.formatter.formatEvent(event as ThreadEvent);
      if (!formatted) continue;

      // Track transient messages for replacement
      if (formatted.isTransient) {
        if (!transientMessage) {
          transientMessage = await this.sendNew(channel, formatted);
        } else {
          await this.editMessage(transientMessage, formatted);
        }
        continue;
      }

      // Non-transient: delete previous transient and send new
      if (transientMessage) {
        await transientMessage.delete().catch(() => {});
        transientMessage = null;
      }

      // Send the main message
      const sent = await this.sendNew(channel, formatted);
      if (sent) {
        MessageRepo.create(
          threadRow.id,
          "codex_to_discord",
          formatted.content ?? "[embed]",
          sent.id,
          (event as any).type,
        );
      }

      // Send extra chunks from message splitting
      if (formatted.extraChunks) {
        for (const chunk of formatted.extraChunks) {
          await this.sendNew(channel, { content: chunk });
        }
      }
    }

    // Clean up remaining transient message
    if (transientMessage) {
      await transientMessage.delete().catch(() => {});
    }
  }

  private async sendNew(
    channel: SendableChannels,
    formatted: FormattedMessage,
  ): Promise<Message | null> {
    try {
      const payload: any = {};
      if (formatted.content) payload.content = formatted.content;
      if (formatted.embeds) payload.embeds = formatted.embeds;
      return await channel.send(payload);
    } catch (error) {
      logger.error("Failed to send Discord message", { error });
      return null;
    }
  }

  private async editMessage(
    message: Message,
    formatted: FormattedMessage,
  ): Promise<void> {
    try {
      const payload: any = {};
      if (formatted.content !== undefined) payload.content = formatted.content;
      if (formatted.embeds) payload.embeds = formatted.embeds;
      await message.edit(payload);
    } catch (error) {
      logger.error("Failed to edit Discord message", { error });
    }
  }

  isProcessing(discordThreadId: string): boolean {
    return this.processing.has(discordThreadId);
  }

  shouldSuppressSessionEcho(
    discordThreadId: string,
    role: "user" | "assistant",
    text: string,
  ): boolean {
    this.pruneExpiredWatcherEchoes();

    const entry = this.recentWatcherEchoes.get(discordThreadId);
    if (!entry) return false;

    const normalized = this.normalizeText(text);
    if (!normalized) return false;

    const knownTexts = role === "user" ? entry.user : entry.assistant;
    return knownTexts.has(normalized);
  }

  private startWatcherEchoSuppression(discordThreadId: string, prompt: string): void {
    const normalized = this.normalizeText(prompt);
    if (!normalized) return;

    this.recentWatcherEchoes.set(discordThreadId, {
      expiresAt: Date.now() + MessageSync.WATCHER_ECHO_TTL_MS,
      user: new Set([normalized]),
      assistant: new Set<string>(),
    });
  }

  private rememberWatcherAssistantEcho(discordThreadId: string, text: string): void {
    const normalized = this.normalizeText(text);
    if (!normalized) return;

    const existing = this.recentWatcherEchoes.get(discordThreadId);
    if (!existing) return;

    existing.assistant.add(normalized);
    existing.expiresAt = Date.now() + MessageSync.WATCHER_ECHO_TTL_MS;
  }

  private extendWatcherEchoSuppression(discordThreadId: string): void {
    const existing = this.recentWatcherEchoes.get(discordThreadId);
    if (!existing) return;

    existing.expiresAt = Date.now() + MessageSync.WATCHER_ECHO_TTL_MS;
  }

  private pruneExpiredWatcherEchoes(): void {
    const now = Date.now();
    for (const [threadId, entry] of this.recentWatcherEchoes.entries()) {
      if (entry.expiresAt > now) continue;
      if (this.processing.has(threadId)) continue;
      this.recentWatcherEchoes.delete(threadId);
    }
  }

  private normalizeText(text: string): string | null {
    const normalized = text.replace(/\r\n?/g, "\n").trim();
    return normalized.length > 0 ? normalized : null;
  }
}
