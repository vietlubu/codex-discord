import "dotenv/config";

/**
 * Verbosity level for Codex event output in Discord:
 *  0 = quiet:    final response only (typing indicator during processing)
 *  1 = normal:   tool names + short reasoning snippets in real-time
 *  2 = detailed: tool names with inputs/outputs + longer reasoning text
 */
export type VerboseLevel = 0 | 1 | 2;

export interface Config {
  discord: {
    token: string;
    guildId: string;
  };
  codex: {
    model: string;
    approvalMode: "never" | "on-request" | "on-failure" | "untrusted";
    sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
    verboseLevel: VerboseLevel;
    syncArchived: boolean;
  };
  database: {
    path: string;
  };
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function parseVerboseLevel(value: string | undefined): VerboseLevel {
  const n = parseInt(value ?? "1", 10);
  if (n === 0 || n === 2) return n;
  return 1; // default
}

export function loadConfig(): Config {
  return {
    discord: {
      token: requireEnv("DISCORD_TOKEN"),
      guildId: requireEnv("DISCORD_GUILD_ID"),
    },
    codex: {
      model: process.env.CODEX_MODEL ?? "o4-mini",
      approvalMode:
        (process.env.CODEX_APPROVAL_MODE as Config["codex"]["approvalMode"]) ??
        "on-failure",
      sandboxMode:
        (process.env.CODEX_SANDBOX_MODE as Config["codex"]["sandboxMode"]) ??
        "workspace-write",
      verboseLevel: parseVerboseLevel(process.env.VERBOSE_LEVEL),
      syncArchived: process.env.SYNC_ARCHIVED === "true",
    },
    database: {
      path: process.env.DATABASE_PATH ?? "./data/codex-discord.db",
    },
  };
}
