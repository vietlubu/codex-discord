# AGENTS.md — Codex Discord Bot

## Project Overview

Discord bot that bridges [OpenAI Codex](https://github.com/openai/codex) sessions to Discord. Each project maps to a Discord channel, each Codex session maps to a thread. Supports real-time auto-sync via file watcher.

## Tech Stack

- **TypeScript** (ES2022, ESM) + Node.js 20+
- **discord.js** v14 — Discord API
- **@openai/codex-sdk** — Codex integration
- **sql.js** — SQLite via WASM (in-memory + manual save to disk)
- **tsup** — Bundler
- **winston** — Logging

## Project Structure

```
src/
├── index.ts              # Entry point, graceful shutdown
├── config/index.ts       # Env loading, Config interface, VerboseLevel
├── bot/client.ts         # DiscordBot class — events, slash commands, auto-sync
├── codex/
│   ├── service.ts        # CodexService — wraps @openai/codex-sdk
│   ├── event-formatter.ts # Formats Codex ThreadEvents → Discord embeds
│   ├── session-scanner.ts # Scans ~/.codex/sessions/ JSONL files
│   └── session-watcher.ts # fs.watch for real-time auto-sync
├── sync/message-sync.ts  # Streams Codex responses to Discord threads
├── storage/
│   ├── database.ts       # sql.js init, save/load from disk
│   └── repositories.ts   # ProjectRepo, ThreadRepo, MessageRepo
├── utils/
│   ├── constants.ts      # Colors, limits, splitMessage(), truncate()
│   └── logger.ts         # Winston logger config
└── types/                # Shared TypeScript types
```

## Commands

```bash
npm run dev        # Dev mode with tsx watch
npm run build      # Production build with tsup
npm run start      # Run production build
npm run typecheck  # tsc --noEmit
npm run lint       # eslint
```

## Key Patterns

### Database (sql.js)
- In-memory SQLite loaded from WASM, not native bindings
- `saveDatabase()` serializes to disk after every write
- `lastInsertRowId()` is unreliable after save — use unique column lookups instead (e.g. `getByChannelId`)

### Auto-Sync (session-watcher.ts)
- Uses `fs.watch` with `recursive: true` (FSEvents on macOS)
- Tracks byte offsets per file to read only appended content
- Debounces 1.5s to wait for Codex to finish writing
- Per-project async lock (`syncLocks`) prevents duplicate channel creation

### Event Formatting
- `VerboseLevel` (0/1/2) gates which Codex events are shown
- Long messages split via `splitMessage()` to respect Discord's 2000-char limit
- `extraChunks` field on FormattedMessage for overflow content

### Discord Mappings
- Project → Channel (1:1, stored in `projects` table)
- Session → Thread (1:1, stored in `threads` table)
- Stale detection: only deletes project on Discord error 10003/50001

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DISCORD_TOKEN` | ✅ | — | Bot token |
| `DISCORD_GUILD_ID` | ✅ | — | Server ID |
| `CODEX_MODEL` | ❌ | `o4-mini` | Codex model |
| `CODEX_APPROVAL_MODE` | ❌ | `on-failure` | Approval flow |
| `CODEX_SANDBOX_MODE` | ❌ | `workspace-write` | Sandbox security |
| `VERBOSE_LEVEL` | ❌ | `1` | 0=quiet, 1=normal, 2=detailed |
| `SYNC_ARCHIVED` | ❌ | `false` | Include archived sessions |
| `DATABASE_PATH` | ❌ | `./data/codex-discord.db` | SQLite path |

## Known Gotchas

- **sql.js save cycle**: `saveDatabase()` re-serializes the entire DB. Don't rely on `last_insert_rowid()` after save — query by unique column instead.
- **Discord thread race condition**: `guild.channels.create()` triggers a `ThreadCreate` event before the creating function returns. Always check `ThreadRepo.getByDiscordThreadId()` before inserting.
- **fs.watch on macOS**: Can fire multiple events for the same file (create + rename + modify). Debounce and dedup are essential.
- **Error serialization**: `JSON.stringify(new Error())` returns `{}`. Always use `serializeError()` helper for Winston logging.
