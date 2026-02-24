import "dotenv/config";

export interface Config {
  discord: {
    token: string;
    guildId: string;
  };
  codex: {
    model: string;
    approvalMode: "never" | "on-request" | "on-failure" | "untrusted";
    sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
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
    },
    database: {
      path: process.env.DATABASE_PATH ?? "./data/codex-discord.db",
    },
  };
}
