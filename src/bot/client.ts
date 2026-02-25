import {
  Client,
  GatewayIntentBits,
  ChannelType,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  type Interaction,
  type Message,
  type ThreadChannel,
  EmbedBuilder,
} from "discord.js";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { Config } from "../config/index.js";
import { CodexService } from "../codex/service.js";
import { MessageSync } from "../sync/message-sync.js";
import { ProjectRepo, ThreadRepo } from "../storage/repositories.js";
import {
  scanAllSessions,
  getSessionsForProject,
  parseSessionMessages,
  getSessionDisplayName,
  getSessionTitle,
  extractAssistantTextsFromSessionEvent,
  extractVisibleUserMessage,
  extractUserTextsFromSessionEvent,
  type CodexSession,
} from "../codex/session-scanner.js";
import { SessionWatcher } from "../codex/session-watcher.js";
import { logger } from "../utils/logger.js";
import { COLORS, CATEGORY_PREFIX, STATUS_EMOJI, DISCORD_MSG_LIMIT, splitMessage } from "../utils/constants.js";
import { canonicalizeProjectPath } from "../utils/path.js";

/**
 * Discord bot client — handles events, slash commands, and bridges to Codex.
 */
export class DiscordBot {
  private client: Client;
  private config: Config;
  private codexService: CodexService;
  private messageSync: MessageSync;
  private sessionWatcher: SessionWatcher;
  /** Per-project lock to prevent concurrent handleNewSession from creating duplicate channels */
  private syncLocks = new Map<string, Promise<void>>();
  /** Buffer session updates while the Discord thread mapping is not ready yet. */
  private pendingSessionLines = new Map<string, string[]>();
  private static readonly MAX_BUFFERED_SESSION_LINES = 2000;

  constructor(config: Config) {
    this.config = config;
    this.codexService = new CodexService(config.codex);
    this.messageSync = new MessageSync(this.codexService, config.codex.verboseLevel);
    this.sessionWatcher = new SessionWatcher(
      (session) =>
        this.handleNewSession(session).catch((err) =>
          logger.error("Auto-sync error", { error: serializeError(err) }),
        ),
      (session, newLines) =>
        this.handleSessionUpdate(session, newLines).catch((err) =>
          logger.error("Auto-sync update error", { error: serializeError(err) }),
        ),
    );

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    this.setupEventHandlers();
  }

  async start(): Promise<void> {
    // Login first so client.application.id is available for command registration
    await this.client.login(this.config.discord.token);
    await this.registerSlashCommands();
    this.startSessionWatcher();
  }

  async stop(): Promise<void> {
    this.sessionWatcher.stop();
    this.pendingSessionLines.clear();
    this.client.destroy();
    logger.info("Discord bot stopped");
  }

  // ─── Auto-Sync Watcher ─────────────────────────────────────────────

  private startSessionWatcher(): void {
    // Mark all existing session files as seen so watcher only fires for new ones
    const existing = scanAllSessions(this.config.codex.syncArchived);
    for (const sessions of existing.values()) {
      for (const s of sessions) {
        this.sessionWatcher.markSeen(s.filePath);
      }
    }
    this.sessionWatcher.start();
  }

  /**
   * Called by SessionWatcher when a new Codex session file appears.
   * Auto-creates the project channel (if needed) and a thread for the session.
   */
  private async handleNewSession(session: {
    id: string;
    cwd: string;
    timestamp: string;
    model: string | undefined;
    filePath: string;
  }): Promise<void> {
    // Serialize by canonical project path to prevent duplicate channel/thread creation.
    const projectPath = canonicalizeProjectPath(session.cwd);
    const prev = this.syncLocks.get(projectPath) ?? Promise.resolve();
    const current = prev.then(() => this._handleNewSessionImpl(session, projectPath));
    const guarded = current.catch(() => {});
    this.syncLocks.set(projectPath, guarded);

    try {
      await current;
    } finally {
      if (this.syncLocks.get(projectPath) === guarded) {
        this.syncLocks.delete(projectPath);
      }
    }
  }

  private async _handleNewSessionImpl(session: {
    id: string;
    cwd: string;
    timestamp: string;
    model: string | undefined;
    filePath: string;
  }, projectPath: string): Promise<void> {
    const guild = this.client.guilds.cache.first();
    if (!guild) return;

    if (!existsSync(projectPath)) return;

    const projectName = basename(projectPath);

    // Find or create project
    let project = this.findProjectByPath(projectPath);
    let projectChannel: any = null; // Keep reference to avoid cache miss

    if (project) {
      // Project exists in DB — verify channel still exists on Discord
      try {
        projectChannel = await guild.channels.fetch(project.channel_id);
        logger.debug("Auto-sync: found existing channel", {
          projectName,
          channelId: project.channel_id,
        });
      } catch (err: any) {
        // Only treat "Unknown Channel" (10003) or "Missing Access" (50001) as stale
        const code = err?.code;
        if (code === 10003 || code === 50001) {
          logger.info("Auto-sync: stale project detected, recreating channel", {
            projectName,
            oldChannelId: project.channel_id,
            errorCode: code,
          });
          ProjectRepo.delete(project.id);
          project = undefined as any;
        } else {
          // Transient error (rate limit, network) — skip, don't recreate
          logger.warn("Auto-sync: channel fetch failed (transient), skipping", {
            projectName,
            error: serializeError(err),
          });
          return;
        }
      }
    }

    if (!project) {
      let createdProjectChannel = true;

      // Auto-create channel for new project
      projectChannel = await guild.channels.create({
        name: projectName.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
        type: ChannelType.GuildText,
        topic: `${CATEGORY_PREFIX} Codex project: ${projectPath}`,
      });

      project = ProjectRepo.create(
        projectChannel.id,
        projectPath,
        projectName,
        session.model,
      );

      if (!project) {
        logger.error("Auto-sync: ProjectRepo.create returned undefined");
        return;
      }

      // Another worker/process may have inserted the canonical project first.
      // If so, delete the extra channel we just created and reuse the existing mapping.
      if (project.channel_id !== projectChannel.id) {
        createdProjectChannel = false;
        await projectChannel
          .delete("Duplicate project channel prevented")
          .catch(() => {});
        projectChannel = await guild.channels.fetch(project.channel_id).catch(() => null);
        if (!projectChannel) {
          logger.warn("Auto-sync: existing mapped channel not accessible", {
            mappedChannelId: project.channel_id,
            projectPath,
          });
          return;
        }
      }

      if (createdProjectChannel) {
        const embed = new EmbedBuilder()
          .setColor(COLORS.PRIMARY)
          .setTitle(`${CATEGORY_PREFIX} Project: ${projectName}`)
          .setDescription(
            `📁 **Path:** \`${projectPath}\`\n` +
              `🤖 **Model:** ${session.model ?? this.config.codex.model}\n\n` +
              `Auto-synced from new Codex session.`,
          )
          .setTimestamp();
        await projectChannel.send({ embeds: [embed] });

        logger.info("Auto-sync: created project channel", { projectName });
      }
    }

    // Get channel reference (reuse if we just created/fetched it)
    if (!projectChannel) return;

    // Check if thread for this session already exists (avoid UNIQUE constraint)
    const existingThread = ThreadRepo.getByCodexThreadId(session.id);
    if (existingThread) {
      await this.flushBufferedSessionLines(session.id, session.cwd);
      return;
    }

    const threadName = getSessionTitle(session);
    try {
      const discordThread = await projectChannel.threads.create({
        name: threadName,
        autoArchiveDuration: 10080,
      });

      const mappedThread = ThreadRepo.getByCodexThreadId(session.id);
      if (mappedThread && mappedThread.discord_thread_id !== discordThread.id) {
        await discordThread
          .delete("Duplicate Codex session thread prevented")
          .catch(() => {});
        return;
      }

      // handleThreadCreate event may have already created the DB row
      // (race condition: Discord emits ThreadCreate before we reach here)
      const alreadyMapped = ThreadRepo.getByDiscordThreadId(discordThread.id);
      if (alreadyMapped) {
        // Just link the codex session ID
        if (!alreadyMapped.codex_thread_id) {
          ThreadRepo.updateCodexThreadId(discordThread.id, session.id);
        }
      } else {
        ThreadRepo.create(discordThread.id, project.id, threadName, session.id);
      }

      const threadEmbed = new EmbedBuilder()
        .setColor(COLORS.INFO)
        .setDescription(
          `🔗 Codex session \`${session.id.slice(0, 12)}...\`\n` +
            `📅 ${session.timestamp}\n` +
            `🤖 ${session.model ?? "default"}\n\n` +
            `Use \`/sync-messages\` to replay this session.`,
        )
        .setTimestamp();
      await discordThread.send({ embeds: [threadEmbed] });
      await this.flushBufferedSessionLines(session.id, session.cwd);

      logger.info("Auto-sync: created thread for session", {
        project: projectName,
        threadName,
        session: session.id.slice(0, 12),
      });
    } catch (err) {
      logger.warn("Auto-sync: failed to create thread", {
        error: serializeError(err),
      });
    }
  }

  private findProjectByPath(projectPath: string) {
    const byPath = ProjectRepo.getByProjectPath(projectPath);
    if (byPath) return byPath;

    const all = ProjectRepo.getAll();
    for (const project of all) {
      if (canonicalizeProjectPath(project.project_path) === projectPath) {
        if (project.project_path !== projectPath) {
          ProjectRepo.updateProjectPath(project.id, projectPath);
          return { ...project, project_path: projectPath };
        }
        return project;
      }
    }

    return undefined;
  }

  /**
   * Called when new lines are appended to an existing session file.
   * Parses the new JSONL lines for user/assistant messages and sends
   * them to the corresponding Discord thread in real-time.
   */
  private async handleSessionUpdate(
    session: { id: string; cwd: string },
    newLines: string[],
  ): Promise<void> {
    // Find the Discord thread linked to this session
    const threadRow = ThreadRepo.getByCodexThreadId(session.id);
    if (!threadRow) {
      this.bufferSessionLines(session.id, newLines);
      return;
    }

    const guild = this.client.guilds.cache.first();
    if (!guild) return;

    // Fetch the Discord thread channel
    let discordThread;
    try {
      discordThread = await guild.channels.fetch(threadRow.discord_thread_id);
    } catch {
      return; // Thread may have been deleted
    }
    if (!discordThread || !discordThread.isTextBased()) return;

    const channel = discordThread as any;
    const sentAssistantBatch = new Set<string>();
    const sentUserBatch = new Set<string>();
    let sendFailures = 0;
    let extractedAssistant = 0;
    let sentAssistant = 0;

    const sendChunked = async (
      prefix: string,
      text: string,
      role: "user" | "assistant",
    ): Promise<boolean> => {
      const chunks = splitMessage(`${prefix}\n${text}`);
      for (const chunk of chunks) {
        try {
          await channel.send({ content: chunk });
        } catch (error) {
          sendFailures++;
          logger.warn("Auto-sync: failed to send message chunk", {
            session: session.id.slice(0, 12),
            discordThreadId: threadRow.discord_thread_id,
            role,
            error: serializeError(error),
          });
          return false;
        }
      }
      return true;
    };

    for (const line of newLines) {
      try {
        const parsed = JSON.parse(line);
        const sendAssistant = async (text: string) => {
          const normalized = String(text).trim();
          if (!normalized) return;
          // Some Codex log formats emit both response_item assistant text and event_msg agent_message.
          if (sentAssistantBatch.has(normalized)) return;
          sentAssistantBatch.add(normalized);
          extractedAssistant++;
          const ok = await sendChunked("🤖 **Codex:**", normalized, "assistant");
          if (ok) sentAssistant++;
        };
        for (const rawUserText of extractUserTextsFromSessionEvent(parsed)) {
          const visibleText = extractVisibleUserMessage(rawUserText);
          if (!visibleText) continue;
          if (sentUserBatch.has(visibleText)) continue;
          sentUserBatch.add(visibleText);
          await sendChunked("👤 **User:**", visibleText, "user");
        }

        for (const assistantText of extractAssistantTextsFromSessionEvent(parsed)) {
          await sendAssistant(assistantText);
        }
      } catch {
        // Skip unparseable lines
      }
    }

    if (extractedAssistant > 0 && sentAssistant === 0) {
      logger.warn("Auto-sync: extracted assistant messages but none were sent", {
        session: session.id.slice(0, 12),
        discordThreadId: threadRow.discord_thread_id,
        extractedAssistant,
        sendFailures,
      });
    }
  }

  private bufferSessionLines(sessionId: string, lines: string[]): void {
    if (lines.length === 0) return;

    const queued = this.pendingSessionLines.get(sessionId) ?? [];
    queued.push(...lines);

    const overflow = queued.length - DiscordBot.MAX_BUFFERED_SESSION_LINES;
    if (overflow > 0) {
      queued.splice(0, overflow);
    }

    this.pendingSessionLines.set(sessionId, queued);

    logger.debug("Buffered session updates while waiting for thread mapping", {
      session: sessionId.slice(0, 12),
      bufferedLines: queued.length,
    });
  }

  private async flushBufferedSessionLines(sessionId: string, cwd: string): Promise<void> {
    const buffered = this.pendingSessionLines.get(sessionId);
    if (!buffered || buffered.length === 0) return;

    this.pendingSessionLines.delete(sessionId);

    logger.debug("Flushing buffered session updates", {
      session: sessionId.slice(0, 12),
      lines: buffered.length,
    });

    await this.handleSessionUpdate({ id: sessionId, cwd }, buffered);
  }

  // ─── Event Handlers ─────────────────────────────────────────────────

  private setupEventHandlers(): void {
    this.client.once(Events.ClientReady, (client) => {
      logger.info(`Discord bot ready: ${client.user.tag}`);
    });

    this.client.on(Events.InteractionCreate, (interaction) => {
      this.handleInteraction(interaction).catch((err) =>
        logger.error("Interaction error", { error: err }),
      );
    });

    this.client.on(Events.MessageCreate, (message) => {
      this.handleMessage(message).catch((err) =>
        logger.error("Message handling error", { error: err }),
      );
    });

    this.client.on(Events.ThreadCreate, (thread) => {
      this.handleThreadCreate(thread).catch((err) =>
        logger.error("Thread create error", { error: err }),
      );
    });
  }

  // ─── Message Handler ────────────────────────────────────────────────

  private async handleMessage(message: Message): Promise<void> {
    // Ignore bot messages, non-thread messages
    if (message.author.bot) return;
    if (!message.channel.isThread()) return;

    const thread = message.channel as ThreadChannel;
    const parentId = thread.parentId;
    if (!parentId) return;

    // Check if parent channel is a mapped project
    const project = ProjectRepo.getByChannelId(parentId);
    if (!project) return;

    // Check/create thread mapping
    let threadRow = ThreadRepo.getByDiscordThreadId(thread.id);
    if (!threadRow) {
      // Auto-register thread if it's in a project channel
      threadRow = ThreadRepo.create(thread.id, project.id, thread.name);
      logger.info("Auto-registered Discord thread", {
        threadId: thread.id,
        projectId: project.id,
      });
    }

    // Forward to Codex
    await this.messageSync.handleUserMessage(message);
  }

  // ─── Thread Create Handler ──────────────────────────────────────────

  private async handleThreadCreate(thread: ThreadChannel): Promise<void> {
    if (!thread.parentId) return;

    const project = ProjectRepo.getByChannelId(thread.parentId);
    if (!project) return;

    // Check if already mapped
    const existing = ThreadRepo.getByDiscordThreadId(thread.id);
    if (existing) return;

    // Register the new thread
    ThreadRepo.create(thread.id, project.id, thread.name);
    logger.info("Thread created and mapped", {
      threadName: thread.name,
      projectName: project.project_name,
    });

    // Send welcome message
    const embed = new EmbedBuilder()
      .setColor(COLORS.PRIMARY)
      .setTitle(`${STATUS_EMOJI.DONE} Codex Thread Ready`)
      .setDescription(
        `Connected to project **${project.project_name}**\n` +
          `📁 \`${project.project_path}\`\n\n` +
          `Send a message to start working with Codex.`,
      )
      .setTimestamp();

    await thread.send({ embeds: [embed] }).catch(() => {});
  }

  // ─── Slash Commands ─────────────────────────────────────────────────

  private async registerSlashCommands(): Promise<void> {
    const commands = [
      new SlashCommandBuilder()
        .setName("setup")
        .setDescription("Add a project directory as a Codex-linked channel")
        .addStringOption((opt) =>
          opt
            .setName("project_path")
            .setDescription("Absolute path to the project directory")
            .setRequired(true),
        )
        .addStringOption((opt) =>
          opt
            .setName("name")
            .setDescription("Custom name for the channel (defaults to directory name)")
            .setRequired(false),
        )
        .addStringOption((opt) =>
          opt
            .setName("model")
            .setDescription("Codex model to use (e.g. o4-mini, gpt-4.1)")
            .setRequired(false),
        ),

      new SlashCommandBuilder()
        .setName("projects")
        .setDescription("List all registered projects"),

      new SlashCommandBuilder()
        .setName("threads")
        .setDescription("List all threads for the current project channel"),

      new SlashCommandBuilder()
        .setName("status")
        .setDescription("Show bot status and statistics"),

      new SlashCommandBuilder()
        .setName("remove-project")
        .setDescription("Remove a project and its channel")
        .addStringOption((opt) =>
          opt
            .setName("project_name")
            .setDescription("Name of the project to remove")
            .setRequired(true),
        ),

      new SlashCommandBuilder()
        .setName("sync-projects")
        .setDescription(
          "Scan local Codex sessions and create channels/threads for discovered projects",
        ),

      new SlashCommandBuilder()
        .setName("sync-messages")
        .setDescription(
          "Replay messages from a Codex session into the current thread",
        )
        .addStringOption((opt) =>
          opt
            .setName("session_id")
            .setDescription(
              "Codex session ID to sync (leave empty to pick from the project's sessions)",
            )
            .setRequired(false),
        ),
    ];

    const rest = new REST({ version: "10" }).setToken(this.config.discord.token);

    const appId = this.client.application?.id;
    if (!appId) {
      logger.error("Cannot register slash commands: client.application.id is unavailable (login first)");
      return;
    }

    try {
      await rest.put(
        Routes.applicationGuildCommands(appId, this.config.discord.guildId),
        { body: commands.map((c) => c.toJSON()) },
      );
      logger.info("Slash commands registered");
    } catch (error) {
      logger.error("Failed to register slash commands", { error: serializeError(error) });
    }
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand()) return;

    switch (interaction.commandName) {
      case "setup":
        await this.handleSetup(interaction);
        break;
      case "projects":
        await this.handleListProjects(interaction);
        break;
      case "threads":
        await this.handleListThreads(interaction);
        break;
      case "status":
        await this.handleStatus(interaction);
        break;
      case "remove-project":
        await this.handleRemoveProject(interaction);
        break;
      case "sync-projects":
        await this.handleSyncProjects(interaction);
        break;
      case "sync-messages":
        await this.handleSyncMessages(interaction);
        break;
    }
  }

  // ─── Command Implementations ────────────────────────────────────────

  private async handleSetup(interaction: any): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const requestedPath = interaction.options.getString("project_path", true);
    const customName = interaction.options.getString("name");
    const model = interaction.options.getString("model");
    const projectPath = canonicalizeProjectPath(requestedPath);

    // Validate path
    if (!existsSync(projectPath)) {
      await interaction.editReply(`❌ Path does not exist: \`${requestedPath}\``);
      return;
    }

    const projectName = customName ?? basename(projectPath);

    // Check if already registered
    const existing = this.findProjectByPath(projectPath);
    if (existing) {
      await interaction.editReply(
        `⚠️ Project already registered as **${existing.project_name}** in <#${existing.channel_id}>`,
      );
      return;
    }

    try {
      // Create channel
      const guild = interaction.guild!;
      const channel = await guild.channels.create({
        name: projectName.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
        type: ChannelType.GuildText,
        topic: `${CATEGORY_PREFIX} Codex project: ${projectPath}`,
      });

      // Save mapping
      const project = ProjectRepo.create(
        channel.id,
        projectPath,
        projectName,
        model ?? undefined,
      );

      if (project.channel_id !== channel.id) {
        await channel.delete("Duplicate project channel prevented").catch(() => {});
        await interaction.editReply(
          `⚠️ Project already registered as **${project.project_name}** in <#${project.channel_id}>`,
        );
        return;
      }

      // Send welcome embed in the new channel
      const embed = new EmbedBuilder()
        .setColor(COLORS.PRIMARY)
        .setTitle(`${CATEGORY_PREFIX} Project: ${projectName}`)
        .setDescription(
          `📁 **Path:** \`${projectPath}\`\n` +
            `🤖 **Model:** ${model ?? this.config.codex.model}\n` +
            `🔒 **Approval:** ${this.config.codex.approvalMode}\n\n` +
            `Create a thread in this channel to start a Codex conversation.`,
        )
        .setTimestamp();

      await channel.send({ embeds: [embed] });

      await interaction.editReply(
        `${STATUS_EMOJI.DONE} Project **${projectName}** added! Channel: <#${channel.id}>`,
      );

      logger.info("Project setup complete", { projectName, projectPath, channelId: channel.id });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await interaction.editReply(`❌ Failed to setup project: ${errorMsg}`);
    }
  }

  private async handleListProjects(interaction: any): Promise<void> {
    const projects = ProjectRepo.getAll();

    if (projects.length === 0) {
      await interaction.reply({
        content: "No projects registered. Use `/setup` to add one.",
        ephemeral: true,
      });
      return;
    }

    const lines = projects.map(
      (p) => `• **${p.project_name}** → <#${p.channel_id}>\n  \`${p.project_path}\``,
    );

    const embed = new EmbedBuilder()
      .setColor(COLORS.PRIMARY)
      .setTitle(`${CATEGORY_PREFIX} Registered Projects (${projects.length})`)
      .setDescription(lines.join("\n\n"));

    await interaction.reply({ embeds: [embed], ephemeral: true });
  }

  private async handleListThreads(interaction: any): Promise<void> {
    const channelId = interaction.channelId;
    const project = ProjectRepo.getByChannelId(channelId);

    if (!project) {
      await interaction.reply({
        content: "This channel is not linked to a project.",
        ephemeral: true,
      });
      return;
    }

    const threads = ThreadRepo.getByProjectId(project.id);

    if (threads.length === 0) {
      await interaction.reply({
        content: "No threads yet. Create a thread to start.",
        ephemeral: true,
      });
      return;
    }

    const lines = threads.map((t) => {
      const status =
        t.status === "active" ? "🟢" : t.status === "error" ? "🔴" : "⚪";
      const codexId = t.codex_thread_id
        ? `\`${t.codex_thread_id.slice(0, 8)}...\``
        : "*not started*";
      return `${status} **${t.thread_name}** → ${codexId}`;
    });

    const embed = new EmbedBuilder()
      .setColor(COLORS.PRIMARY)
      .setTitle(`Threads for ${project.project_name} (${threads.length})`)
      .setDescription(lines.join("\n"));

    await interaction.reply({ embeds: [embed], ephemeral: true });
  }

  private async handleStatus(interaction: any): Promise<void> {
    const projects = ProjectRepo.getAll();
    const activeThreads = projects.reduce((acc, p) => {
      return acc + ThreadRepo.getByProjectId(p.id).filter((t) => t.status === "active").length;
    }, 0);

    const embed = new EmbedBuilder()
      .setColor(COLORS.PRIMARY)
      .setTitle("🤖 Codex Discord Bot Status")
      .addFields(
        { name: "Projects", value: `${projects.length}`, inline: true },
        { name: "Active Threads", value: `${activeThreads}`, inline: true },
        { name: "Model", value: this.config.codex.model, inline: true },
        { name: "Approval", value: this.config.codex.approvalMode, inline: true },
        { name: "Sandbox", value: this.config.codex.sandboxMode, inline: true },
      )
      .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
  }

  private async handleRemoveProject(interaction: any): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const projectName = interaction.options.getString("project_name", true);
    const project = ProjectRepo.getAll().find(
      (p) => p.project_name.toLowerCase() === projectName.toLowerCase(),
    );

    if (!project) {
      await interaction.editReply(`❌ Project not found: **${projectName}**`);
      return;
    }

    try {
      // Delete the channel
      const guild = interaction.guild!;
      const channel = guild.channels.cache.get(project.channel_id);
      if (channel) {
        await channel.delete(`Removed project: ${projectName}`);
      }

      // Delete from DB (cascades to threads)
      ProjectRepo.delete(project.id);

      await interaction.editReply(`${STATUS_EMOJI.DONE} Project **${projectName}** removed.`);
      logger.info("Project removed", { projectName });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await interaction.editReply(`❌ Failed to remove: ${errorMsg}`);
    }
  }

  // ─── Sync Commands ──────────────────────────────────────────────────

  /**
   * /sync-projects — Scan ~/.codex/sessions, discover projects,
   * and create Discord channels + threads for each.
   */
  private async handleSyncProjects(interaction: any): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    try {
      const sessionsByProject = scanAllSessions(this.config.codex.syncArchived);

      if (sessionsByProject.size === 0) {
        await interaction.editReply(
          "No Codex sessions found in `~/.codex/sessions/`.",
        );
        return;
      }

      const guild = interaction.guild!;
      let created = 0;
      let skipped = 0;
      const details: string[] = [];

      for (const [projectPath, sessions] of sessionsByProject) {
        const canonicalProjectPath = canonicalizeProjectPath(projectPath);

        // Skip if project already registered
        const existing = this.findProjectByPath(canonicalProjectPath);
        if (existing) {
          skipped++;
          continue;
        }

        // Skip if path doesn't exist
        if (!existsSync(canonicalProjectPath)) {
          skipped++;
          continue;
        }

        const projectName = basename(canonicalProjectPath);
        const model = sessions[0]?.model;

        // Create channel
        const channel = await guild.channels.create({
          name: projectName.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
          type: ChannelType.GuildText,
          topic: `${CATEGORY_PREFIX} Codex project: ${canonicalProjectPath}`,
        });

        // Save to DB
        const projectRow = ProjectRepo.create(
          channel.id,
          canonicalProjectPath,
          projectName,
          model,
        );

        if (projectRow.channel_id !== channel.id) {
          await channel.delete("Duplicate project channel prevented").catch(() => {});
          skipped++;
          continue;
        }

        // Send welcome embed
        const embed = new EmbedBuilder()
          .setColor(COLORS.PRIMARY)
          .setTitle(`${CATEGORY_PREFIX} Project: ${projectName}`)
          .setDescription(
            `📁 **Path:** \`${canonicalProjectPath}\`\n` +
              `🤖 **Model:** ${model ?? this.config.codex.model}\n` +
              `📊 **Sessions found:** ${sessions.length}\n\n` +
              `Synced from local Codex sessions.`,
          )
          .setTimestamp();
        await channel.send({ embeds: [embed] });

        // Create a Discord thread for each Codex session
        const seenSessionIds = new Set<string>();
        for (const session of sessions) {
          if (seenSessionIds.has(session.id)) continue;
          seenSessionIds.add(session.id);

          if (ThreadRepo.getByCodexThreadId(session.id)) {
            continue;
          }

          const threadName = getSessionDisplayName(session);
          try {
            const discordThread = await channel.threads.create({
              name: threadName,
              autoArchiveDuration: 10080, // 7 days
            });

            const threadRow = ThreadRepo.create(
              discordThread.id,
              projectRow.id,
              threadName,
              session.id,
            );

            if (threadRow.discord_thread_id !== discordThread.id) {
              await discordThread
                .delete("Duplicate Codex session thread prevented")
                .catch(() => {});
              continue;
            }

            // Send info embed in thread
            const threadEmbed = new EmbedBuilder()
              .setColor(COLORS.INFO)
              .setDescription(
                `🔗 Codex session \`${session.id.slice(0, 12)}...\`\n` +
                  `📅 ${session.timestamp}\n` +
                  `🤖 ${session.model ?? "default"}\n\n` +
                  `Use \`/sync-messages\` to replay this session's messages.`,
              )
              .setTimestamp();
            await discordThread.send({ embeds: [threadEmbed] });
          } catch (err) {
            logger.warn("Failed to create thread for session", {
              session: session.id,
              error: err,
            });
          }
        }

        created++;
        details.push(
          `${STATUS_EMOJI.DONE} **${projectName}** — ${sessions.length} sessions → <#${channel.id}>`,
        );
      }

      const summary =
        `**Sync complete**\n\n` +
        `✅ Created: ${created} projects\n` +
        `⏭️ Skipped: ${skipped} (already registered or path missing)\n\n` +
        details.join("\n");

      await interaction.editReply(summary.slice(0, DISCORD_MSG_LIMIT));
      logger.info("Sync projects complete", { created, skipped });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await interaction.editReply(`❌ Sync failed: ${errorMsg}`);
    }
  }

  /**
   * /sync-messages — Replay messages from a Codex session JSONL file
   * into the current Discord thread.
   */
  private async handleSyncMessages(interaction: any): Promise<void> {
    await interaction.deferReply();

    const discordThreadId = interaction.channelId;
    const requestedSessionId = interaction.options.getString("session_id");

    // Must be in a thread
    if (!interaction.channel?.isThread?.()) {
      await interaction.editReply(
        "❌ This command must be used inside a thread.",
      );
      return;
    }

    // Find thread mapping
    const threadRow = ThreadRepo.getByDiscordThreadId(discordThreadId);
    if (!threadRow) {
      await interaction.editReply(
        "❌ This thread is not linked to a Codex project. Use `/sync-projects` first.",
      );
      return;
    }

    const project = ProjectRepo.getById(threadRow.project_id);
    if (!project) {
      await interaction.editReply("❌ Project not found.");
      return;
    }

    // Find the session to sync
    let sessionFilePath: string | null = null;

    if (requestedSessionId) {
      // User specified a session ID
      const sessions = getSessionsForProject(project.project_path, this.config.codex.syncArchived);
      const match = sessions.find((s) => s.id === requestedSessionId);
      if (!match) {
        await interaction.editReply(
          `❌ Session not found: \`${requestedSessionId}\``,
        );
        return;
      }
      sessionFilePath = match.filePath;
    } else if (threadRow.codex_thread_id) {
      // Use the session linked to this thread
      const sessions = getSessionsForProject(project.project_path, this.config.codex.syncArchived);
      const match = sessions.find((s) => s.id === threadRow.codex_thread_id);
      if (match) {
        sessionFilePath = match.filePath;
      } else {
        // List available sessions
        const lines = sessions
          .slice(0, 15)
          .map(
            (s) =>
              `\`${s.id}\` — ${getSessionDisplayName(s)} (${s.model ?? "default"})`,
          );
        await interaction.editReply(
          `❌ Session \`${threadRow.codex_thread_id}\` not found on disk.\n\n` +
            `**Available sessions for this project:**\n${lines.join("\n") || "None"} \n\n` +
            `Use \`/sync-messages session_id:<id>\` to sync a specific one.`,
        );
        return;
      }
    } else {
      // No session linked — list available sessions
      const sessions = getSessionsForProject(project.project_path, this.config.codex.syncArchived);
      if (sessions.length === 0) {
        await interaction.editReply(
          "❌ No Codex sessions found for this project.",
        );
        return;
      }
      const lines = sessions
        .slice(0, 15)
        .map(
          (s) =>
            `\`${s.id}\` — ${getSessionDisplayName(s)} (${s.model ?? "default"})`,
        );
      await interaction.editReply(
        `**Available sessions for ${project.project_name}:**\n${lines.join("\n")}\n\n` +
          `Use \`/sync-messages session_id:<id>\` to sync one.`,
      );
      return;
    }

    // Parse and send messages
    try {
      const messages = parseSessionMessages(sessionFilePath!);
      const replayMessages = messages.filter(
        (m) => m.role === "user" || (m.role === "assistant" && m.type === "text"),
      );

      if (replayMessages.length === 0) {
        await interaction.editReply(
          "No chat messages found in this session.",
        );
        return;
      }

      const userCount = replayMessages.filter((m) => m.role === "user").length;
      const assistantCount = replayMessages.filter(
        (m) => m.role === "assistant" && m.type === "text",
      ).length;

      await interaction.editReply(
        `${STATUS_EMOJI.WORKING} Syncing **${replayMessages.length}** messages ` +
          `(user: ${userCount}, codex: ${assistantCount})...`,
      );

      const thread = interaction.channel;
      let sent = 0;
      let failed = 0;

      for (const msg of replayMessages) {
        const prefix = msg.role === "user" ? "👤 **User:**" : "🤖 **Codex:**";
        const fullContent = `${prefix}\n${msg.text}`;

        // Split long messages into chunks
        const chunks = splitMessage(fullContent);
        for (const chunk of chunks) {
          try {
            await thread.send({ content: chunk });
          } catch (error) {
            failed++;
            logger.warn("Sync messages: failed to send replay chunk", {
              threadId: discordThreadId,
              role: msg.role,
              error: serializeError(error),
            });
            break;
          }
        }
        sent++;

        // Rate limit: don't flood
        if (sent % 5 === 0) {
          await new Promise((r) => setTimeout(r, 1000));
        }
      }

      const doneEmbed = new EmbedBuilder()
        .setColor(COLORS.SUCCESS)
        .setDescription(
          `${STATUS_EMOJI.DONE} Synced **${sent}** messages from Codex session.` +
            (failed > 0 ? `\n⚠️ Failed chunks: **${failed}**` : ""),
        )
        .setTimestamp();
      await thread.send({ embeds: [doneEmbed] });

      logger.info("Sync messages complete", {
        sent,
        failed,
        userCount,
        assistantCount,
        threadId: discordThreadId,
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await interaction.editReply(`❌ Sync failed: ${errorMsg}`);
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

/** Serialize an Error into a plain object that Winston can log properly. */
function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      message: err.message,
      name: err.name,
      stack: err.stack,
      ...(err as any).code ? { code: (err as any).code } : {},
      ...(err as any).status ? { status: (err as any).status } : {},
    };
  }
  return { message: String(err) };
}
