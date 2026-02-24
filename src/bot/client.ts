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
import { logger } from "../utils/logger.js";
import { COLORS, CATEGORY_PREFIX, STATUS_EMOJI } from "../utils/constants.js";

/**
 * Discord bot client — handles events, slash commands, and bridges to Codex.
 */
export class DiscordBot {
  private client: Client;
  private config: Config;
  private codexService: CodexService;
  private messageSync: MessageSync;

  constructor(config: Config) {
    this.config = config;
    this.codexService = new CodexService(config.codex);
    this.messageSync = new MessageSync(this.codexService);

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
    await this.registerSlashCommands();
    await this.client.login(this.config.discord.token);
  }

  async stop(): Promise<void> {
    this.client.destroy();
    logger.info("Discord bot stopped");
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
    ];

    const rest = new REST({ version: "10" }).setToken(this.config.discord.token);

    try {
      await rest.put(
        Routes.applicationGuildCommands(
          this.client.application?.id ?? (await this.client.login(this.config.discord.token)).split(".")[0]!,
          this.config.discord.guildId,
        ),
        { body: commands.map((c) => c.toJSON()) },
      );
      logger.info("Slash commands registered");
    } catch (error) {
      logger.error("Failed to register slash commands", { error });
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
    }
  }

  // ─── Command Implementations ────────────────────────────────────────

  private async handleSetup(interaction: any): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const projectPath = interaction.options.getString("project_path", true);
    const customName = interaction.options.getString("name");
    const model = interaction.options.getString("model");

    // Validate path
    if (!existsSync(projectPath)) {
      await interaction.editReply(`❌ Path does not exist: \`${projectPath}\``);
      return;
    }

    const projectName = customName ?? basename(projectPath);

    // Check if already registered
    const existing = ProjectRepo.getAll().find(
      (p) => p.project_path === projectPath,
    );
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
      ProjectRepo.create(channel.id, projectPath, projectName, model ?? undefined);

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
}
