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
