# 🤖 Codex Discord Bot

Discord bot for monitoring and interacting with [OpenAI Codex](https://github.com/openai/codex) from Discord.

## Features

- **Project ↔ Channel mapping** — Each Discord channel = one Codex project
- **Thread ↔ Thread mapping** — Each Discord thread = one Codex conversation
- **Bidirectional chat** — Send messages from Discord → Codex, stream responses back
- **Rich formatting** — Codex events displayed as embeds (reasoning, commands, file changes, todo lists)
- **Thread persistence** — Conversations resume across bot restarts via Codex SDK

## Quick Start

```bash
# 1. Clone and install
cd codex-discord
npm install

# 2. Configure
cp .env.example .env
# Edit .env with your Discord token, Guild ID, and OpenAI API key

# 3. Run
npm run dev
```

## Slash Commands

| Command | Description |
|---|---|
| `/setup` | Add a project directory as a Codex-linked channel |
| `/projects` | List all registered projects |
| `/threads` | List threads in current project channel |
| `/status` | Show bot status and statistics |
| `/remove-project` | Remove a project and its channel |

## How It Works

1. Use `/setup` to link a project directory → creates a Discord channel
2. Create threads in the channel → each thread connects to Codex
3. Send messages in threads → Codex processes and streams responses back
4. Codex responses include: reasoning, shell commands, file changes, final answer

## Environment Variables

```bash
DISCORD_TOKEN=       # Discord bot token
DISCORD_GUILD_ID=    # Discord server ID
OPENAI_API_KEY=      # OpenAI API key
CODEX_MODEL=         # Default model (default: o4-mini)
CODEX_APPROVAL_MODE= # never | on-request | on-failure | untrusted
CODEX_SANDBOX_MODE=  # read-only | workspace-write | danger-full-access
DATABASE_PATH=       # SQLite database path (default: ./data/codex-discord.db)
```

## Tech Stack

- **TypeScript** + Node.js 20+
- **discord.js** v14 — Discord API
- **@openai/codex-sdk** — Codex integration
- **sql.js** — SQLite (WASM, no native build)
- **tsup** — Build tool

## License

MIT
