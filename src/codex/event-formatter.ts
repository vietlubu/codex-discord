import { EmbedBuilder } from "discord.js";
import type { ThreadEvent } from "@openai/codex-sdk";
import { COLORS, STATUS_EMOJI, DISCORD_MSG_LIMIT } from "../utils/constants.js";

/**
 * Formats Codex SDK events into Discord-friendly messages and embeds.
 */
export class EventFormatter {
  /**
   * Format a Codex event into a Discord-sendable payload.
   * Returns null if the event should be skipped.
   */
  formatEvent(event: ThreadEvent): FormattedMessage | null {
    switch (event.type) {
      case "thread.started":
        return null; // Internal event, handled by sync logic

      case "turn.started":
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
        return {
          embeds: [
            new EmbedBuilder()
              .setColor(COLORS.SUCCESS)
              .setDescription(
                `${STATUS_EMOJI.DONE} **Turn completed** — ` +
                  `${event.usage.input_tokens.toLocaleString()} input / ` +
                  `${event.usage.output_tokens.toLocaleString()} output tokens`,
              )
              .setTimestamp(),
          ],
        };

      case "turn.failed":
        return {
          embeds: [
            new EmbedBuilder()
              .setColor(COLORS.ERROR)
              .setDescription(`${STATUS_EMOJI.ERROR} **Error:** ${event.error.message}`)
              .setTimestamp(),
          ],
        };

      case "error":
        return {
          embeds: [
            new EmbedBuilder()
              .setColor(COLORS.ERROR)
              .setDescription(`${STATUS_EMOJI.ERROR} **Stream error:** ${event.message}`)
              .setTimestamp(),
          ],
        };

      default:
        return null;
    }
  }

  private formatItemStarted(event: Extract<ThreadEvent, { type: "item.started" }>): FormattedMessage | null {
    const item = event.item;
    switch (item.type) {
      case "reasoning":
        return {
          content: `${STATUS_EMOJI.REASONING} *Thinking...*`,
          isTransient: true,
        };

      case "command_execution":
        return {
          content: `${STATUS_EMOJI.COMMAND} Running: \`${truncate(item.command, 100)}\``,
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

  private formatItemUpdated(event: Extract<ThreadEvent, { type: "item.updated" }>): FormattedMessage | null {
    const item = event.item;
    switch (item.type) {
      case "command_execution":
        if (item.aggregated_output) {
          return {
            content: `${STATUS_EMOJI.COMMAND} Running: \`${truncate(item.command, 80)}\`\n\`\`\`\n${truncate(item.aggregated_output, 500)}\n\`\`\``,
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

  private formatItemCompleted(event: Extract<ThreadEvent, { type: "item.completed" }>): FormattedMessage | null {
    const item = event.item;
    switch (item.type) {
      case "agent_message":
        return {
          content: truncateMessage(item.text),
        };

      case "reasoning":
        if (!item.text) return null;
        return {
          embeds: [
            new EmbedBuilder()
              .setColor(COLORS.REASONING)
              .setTitle(`${STATUS_EMOJI.REASONING} Reasoning`)
              .setDescription(truncate(item.text, 1000)),
          ],
        };

      case "command_execution": {
        const exitInfo =
          item.exit_code !== undefined ? ` (exit ${item.exit_code})` : "";
        const statusIcon =
          item.status === "completed" && item.exit_code === 0
            ? STATUS_EMOJI.DONE
            : STATUS_EMOJI.ERROR;
        const output = item.aggregated_output
          ? `\n\`\`\`\n${truncate(item.aggregated_output, 1200)}\n\`\`\``
          : "";
        return {
          embeds: [
            new EmbedBuilder()
              .setColor(
                item.exit_code === 0 ? COLORS.SUCCESS : COLORS.ERROR,
              )
              .setDescription(
                `${statusIcon} \`${truncate(item.command, 200)}\`${exitInfo}${output}`,
              ),
          ],
        };
      }

      case "file_change": {
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
        const result = item.status === "completed" ? STATUS_EMOJI.DONE : STATUS_EMOJI.ERROR;
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
        return {
          embeds: [
            new EmbedBuilder()
              .setColor(COLORS.INFO)
              .setDescription(`${STATUS_EMOJI.SEARCH} **Web search:** ${item.query}`),
          ],
        };

      case "todo_list":
        return {
          embeds: [this.formatTodoList(item.items, "completed")],
        };

      case "error":
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
}

// ─── Types ───────────────────────────────────────────────────────────

export interface FormattedMessage {
  content?: string;
  embeds?: EmbedBuilder[];
  /** If true, this message should replace the previous transient message */
  isTransient?: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
}

function truncateMessage(text: string): string {
  if (text.length <= DISCORD_MSG_LIMIT) return text;
  return text.slice(0, DISCORD_MSG_LIMIT - 20) + "\n\n*[truncated]*";
}
