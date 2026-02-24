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
# Edit .env with your Discord token, Guild ID, etc.

# 3. Run
npm run dev
```

## Discord Bot Setup

### 1. Create Bot Application

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application** → name it (e.g. "Codex Bot") → Create
3. Go to **Bot** tab → click **Reset Token** → copy the token → save as `DISCORD_TOKEN` in `.env`

### 2. Enable Privileged Intents

Still in the **Bot** tab, scroll down to **Privileged Gateway Intents** and enable:

- ✅ **MESSAGE CONTENT INTENT** (required — bot reads message text)
- ✅ **SERVER MEMBERS INTENT** (optional)

Click **Save Changes**.

### 3. Invite Bot to Server

Go to **OAuth2** → **URL Generator**:

**Scopes:**
- ✅ `bot`
- ✅ `applications.commands`

**Bot Permissions:**
- ✅ Manage Channels
- ✅ Send Messages
- ✅ Manage Threads
- ✅ Read Message History
- ✅ Use Slash Commands

Copy the generated URL → open in browser → select your server → **Authorize**.

Or use this URL directly (replace `YOUR_CLIENT_ID` with your Application ID):

```
https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=397553205248&scope=bot%20applications.commands
```

### 4. Get Guild ID

1. In Discord, go to **Settings → Advanced → Developer Mode** → enable
2. Right-click your server name → **Copy Server ID**
3. Save as `DISCORD_GUILD_ID` in `.env`

## Slash Commands

| Command | Description |
|---|---|
| `/setup` | Add a project directory as a Codex-linked channel |
| `/projects` | List all registered projects |
| `/threads` | List threads in current project channel |
| `/status` | Show bot status and statistics |
| `/remove-project` | Remove a project and its channel |
| `/sync-projects` | Scan local Codex sessions and create channels/threads |
| `/sync-messages` | Replay messages from a Codex session into current thread |

## How It Works

1. Use `/setup` to link a project directory → creates a Discord channel
2. Create threads in the channel → each thread connects to Codex
3. Send messages in threads → Codex processes and streams responses back
4. Codex responses include: reasoning, shell commands, file changes, final answer

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DISCORD_TOKEN` | ✅ | — | Discord bot token |
| `DISCORD_GUILD_ID` | ✅ | — | Discord server ID |
| `OPENAI_API_KEY` | ❌ | — | Not needed if logged in via Codex App |
| `CODEX_MODEL` | ❌ | `o4-mini` | Default Codex model |
| `CODEX_APPROVAL_MODE` | ❌ | `on-failure` | `never` \| `on-request` \| `on-failure` \| `untrusted` |
| `CODEX_SANDBOX_MODE` | ❌ | `workspace-write` | `read-only` \| `workspace-write` \| `danger-full-access` |
| `VERBOSE_LEVEL` | ❌ | `1` | `0` = quiet (final only), `1` = normal, `2` = detailed |
| `DATABASE_PATH` | ❌ | `./data/codex-discord.db` | SQLite database path |

## Tech Stack

- **TypeScript** + Node.js 20+
- **discord.js** v14 — Discord API
- **@openai/codex-sdk** — Codex integration
- **sql.js** — SQLite (WASM, no native build)
- **tsup** — Build tool

## License

MIT
