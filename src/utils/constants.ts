/** Discord embed color palette */
export const COLORS = {
  PRIMARY: 0x5865f2, // Discord blurple
  SUCCESS: 0x57f287, // Green
  WARNING: 0xfee75c, // Yellow
  ERROR: 0xed4245, // Red
  INFO: 0x5865f2, // Blue
  REASONING: 0x99aab5, // Gray
  COMMAND: 0x2f3136, // Dark
  FILE_CHANGE: 0xe67e22, // Orange
} as const;

/** Discord message character limit */
export const DISCORD_MSG_LIMIT = 2000;

/** Discord embed description limit */
export const DISCORD_EMBED_LIMIT = 4096;

/** Category name prefix for codex projects */
export const CATEGORY_PREFIX = "📁";

/** Thread status indicators */
export const STATUS_EMOJI = {
  WORKING: "⏳",
  DONE: "✅",
  ERROR: "❌",
  REASONING: "🧠",
  COMMAND: "💻",
  FILE_CHANGE: "📝",
  MESSAGE: "💬",
  TODO: "📋",
  SEARCH: "🔍",
} as const;

// ─── Message Splitting ─────────────────────────────────────────────

/**
 * Split a long text message into chunks that fit within Discord's message limit.
 * Tries to split at newline or space boundaries for readability.
 */
export function splitMessage(
  text: string,
  limit: number = DISCORD_MSG_LIMIT,
): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    // Try to find a good split point: newline, then space
    let splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt < limit * 0.3) {
      // Newline too far back, try space
      splitAt = remaining.lastIndexOf(" ", limit);
    }
    if (splitAt < limit * 0.3) {
      // No good split point, hard cut
      splitAt = limit;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}

/**
 * Split a long text for embed descriptions (4096 char limit).
 */
export function splitEmbedDescription(text: string): string[] {
  return splitMessage(text, DISCORD_EMBED_LIMIT);
}
