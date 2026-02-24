import { EmbedBuilder } from "discord.js";
import type { ThreadEvent } from "@openai/codex-sdk";
import type { VerboseLevel } from "../config/index.js";
import {
  COLORS,
  STATUS_EMOJI,
  DISCORD_MSG_LIMIT,
  DISCORD_EMBED_LIMIT,
  splitMessage,
} from "../utils/constants.js";

/**
 * Formats Codex SDK events into Discord-friendly messages and embeds.
 *
 * Respects verboseLevel:
 *   0 (quiet)    — final response only (agent_message, errors)
 *   1 (normal)   — tool names + short reasoning snippets
 *   2 (detailed) — tool names with inputs/outputs + longer reasoning
 */
export class EventFormatter {
  private verboseLevel: VerboseLevel;

  constructor(verboseLevel: VerboseLevel = 1) {
    this.verboseLevel = verboseLevel;
  }

  setVerboseLevel(level: VerboseLevel): void {
    this.verboseLevel = level;
  }

  /**
   * Format a Codex event into Discord-sendable payload(s).
   * Returns null if the event should be skipped at current verbosity.
   */
  formatEvent(event: ThreadEvent): FormattedMessage | null {
    switch (event.type) {
      case "thread.started":
        return null;

      case "turn.started":
        // All levels see "Working..." indicator
        return {
          content: `${STATUS_EMOJI.WORKING} **Working...**`,
          isTransient: true,
        };

      case "item.started":
        return this.formatItemStarted(event);

      case "item.updated":
        return this.formatItemUpdated(event);

      case "item.completed":
        return this.formatItemCompleted(event);

      case "turn.completed":
        // Level 0: silent. Level 1+: show token usage.
        if (this.verboseLevel === 0) return null;
        return {
          embeds: [
            new EmbedBuilder()
              .setColor(COLORS.SUCCESS)
              .setDescription(
                `${STATUS_EMOJI.DONE} **Turn completed** — ` +
                  `${event.usage.input_tokens.toLocaleString()} in / ` +
                  `${event.usage.output_tokens.toLocaleString()} out`,
              )
              .setTimestamp(),
          ],
        };

      case "turn.failed":
        // Always show errors
        return {
          embeds: [
            new EmbedBuilder()
              .setColor(COLORS.ERROR)
              .setDescription(
                `${STATUS_EMOJI.ERROR} **Error:** ${event.error.message}`,
              )
              .setTimestamp(),
          ],
        };

      case "error":
        return {
          embeds: [
            new EmbedBuilder()
              .setColor(COLORS.ERROR)
              .setDescription(
                `${STATUS_EMOJI.ERROR} **Stream error:** ${event.message}`,
              )
              .setTimestamp(),
          ],
        };

      default:
        return null;
    }
  }

  // ─── item.started ──────────────────────────────────────────────────

  private formatItemStarted(
    event: Extract<ThreadEvent, { type: "item.started" }>,
  ): FormattedMessage | null {
    if (this.verboseLevel === 0) return null;

    const item = event.item;
    switch (item.type) {
      case "reasoning":
        return {
          content: `${STATUS_EMOJI.REASONING} *Thinking...*`,
          isTransient: true,
        };

      case "command_execution":
        if (this.verboseLevel >= 2) {
          return {
            content: `${STATUS_EMOJI.COMMAND} Running: \`${truncate(item.command, 200)}\``,
            isTransient: true,
          };
        }
        return {
          content: `${STATUS_EMOJI.COMMAND} Running command...`,
          isTransient: true,
        };

      case "todo_list":
        return {
          embeds: [this.formatTodoList(item.items, "in progress")],
          isTransient: true,
        };

      default:
        return null;
    }
  }

  // ─── item.updated ──────────────────────────────────────────────────

  private formatItemUpdated(
    event: Extract<ThreadEvent, { type: "item.updated" }>,
  ): FormattedMessage | null {
    if (this.verboseLevel === 0) return null;

    const item = event.item;
    switch (item.type) {
      case "command_execution":
        if (this.verboseLevel >= 2 && item.aggregated_output) {
          return {
            content:
              `${STATUS_EMOJI.COMMAND} Running: \`${truncate(item.command, 80)}\`\n` +
              `\`\`\`\n${truncate(item.aggregated_output, 800)}\n\`\`\``,
            isTransient: true,
          };
        }
        return null;

      case "todo_list":
        return {
          embeds: [this.formatTodoList(item.items, "in progress")],
          isTransient: true,
        };

      default:
        return null;
    }
  }

  // ─── item.completed ────────────────────────────────────────────────

  private formatItemCompleted(
    event: Extract<ThreadEvent, { type: "item.completed" }>,
  ): FormattedMessage | null {
    const item = event.item;
    switch (item.type) {
      case "agent_message":
        // Always show final agent messages (all levels)
        return this.makeChunkedContent(item.text);

      case "reasoning": {
        if (this.verboseLevel === 0) return null;
        if (!item.text) return null;

        const maxLen = this.verboseLevel >= 2 ? 2000 : 500;
        return {
          embeds: [
            new EmbedBuilder()
              .setColor(COLORS.REASONING)
              .setTitle(`${STATUS_EMOJI.REASONING} Reasoning`)
              .setDescription(truncate(item.text, maxLen)),
          ],
        };
      }

      case "command_execution": {
        // Level 0: skip command output entirely
        if (this.verboseLevel === 0) return null;

        const exitInfo =
          item.exit_code !== undefined ? ` (exit ${item.exit_code})` : "";
        const statusIcon =
          item.status === "completed" && item.exit_code === 0
            ? STATUS_EMOJI.DONE
            : STATUS_EMOJI.ERROR;

        const outputLimit = this.verboseLevel >= 2 ? 2000 : 500;
        const output = item.aggregated_output
          ? `\n\`\`\`\n${truncate(item.aggregated_output, outputLimit)}\n\`\`\``
          : "";

        const cmdLimit = this.verboseLevel >= 2 ? 500 : 100;
        return {
          embeds: [
            new EmbedBuilder()
              .setColor(item.exit_code === 0 ? COLORS.SUCCESS : COLORS.ERROR)
              .setDescription(
                `${statusIcon} \`${truncate(item.command, cmdLimit)}\`${exitInfo}${output}`,
              ),
          ],
        };
      }

      case "file_change": {
        if (this.verboseLevel === 0) return null;
        const changes = item.changes
          .map((c) => {
            const icon =
              c.kind === "add" ? "➕" : c.kind === "delete" ? "➖" : "✏️";
            return `${icon} \`${c.path}\``;
          })
          .join("\n");
        return {
          embeds: [
            new EmbedBuilder()
              .setColor(COLORS.FILE_CHANGE)
              .setTitle(`${STATUS_EMOJI.FILE_CHANGE} File Changes`)
              .setDescription(changes || "No changes"),
          ],
        };
      }

      case "mcp_tool_call": {
        if (this.verboseLevel === 0) return null;
        const result =
          item.status === "completed" ? STATUS_EMOJI.DONE : STATUS_EMOJI.ERROR;
        return {
          embeds: [
            new EmbedBuilder()
              .setColor(COLORS.INFO)
              .setDescription(
                `🔧 **MCP Tool:** ${item.server}/${item.tool} ${result}`,
              ),
          ],
        };
      }

      case "web_search":
        if (this.verboseLevel === 0) return null;
        return {
          embeds: [
            new EmbedBuilder()
              .setColor(COLORS.INFO)
              .setDescription(
                `${STATUS_EMOJI.SEARCH} **Web search:** ${item.query}`,
              ),
          ],
        };

      case "todo_list":
        if (this.verboseLevel === 0) return null;
        return {
          embeds: [this.formatTodoList(item.items, "completed")],
        };

      case "error":
        // Always show errors
        return {
          embeds: [
            new EmbedBuilder()
              .setColor(COLORS.ERROR)
              .setDescription(`${STATUS_EMOJI.ERROR} ${item.message}`),
          ],
        };

      default:
        return null;
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────

  private formatTodoList(
    items: Array<{ text: string; completed: boolean }>,
    status: string,
  ): EmbedBuilder {
    const lines = items.map(
      (item) => `${item.completed ? "✅" : "⬜"} ${item.text}`,
    );
    return new EmbedBuilder()
      .setColor(COLORS.INFO)
      .setTitle(`${STATUS_EMOJI.TODO} Todo List`)
      .setDescription(lines.join("\n") || "Empty");
  }

  /**
   * Build a FormattedMessage that auto-chunks long content text.
   * The first chunk is the primary message; extras are stored in `extraChunks`.
   */
  private makeChunkedContent(text: string): FormattedMessage {
    const chunks = splitMessage(text, DISCORD_MSG_LIMIT);
    return {
      content: chunks[0],
      extraChunks: chunks.length > 1 ? chunks.slice(1) : undefined,
    };
  }
}

// ─── Types ───────────────────────────────────────────────────────────

export interface FormattedMessage {
  content?: string;
  embeds?: EmbedBuilder[];
  /** If true, this message should replace the previous transient message */
  isTransient?: boolean;
  /** Additional text chunks to send as separate messages (for long content) */
  extraChunks?: string[];
}

// ─── Helpers ─────────────────────────────────────────────────────────

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
}
