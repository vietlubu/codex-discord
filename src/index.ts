import { loadConfig } from "./config/index.js";
import { initDatabase } from "./storage/database.js";
import { DiscordBot } from "./bot/client.js";
import { logger } from "./utils/logger.js";

async function main(): Promise<void> {
  logger.info("Starting Codex Discord Bot...");

  // Load configuration
  const config = loadConfig();

  // Initialize database
  initDatabase(config.database.path);

  // Start Discord bot
  const bot = new DiscordBot(config);
  await bot.start();

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    await bot.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  logger.info("Codex Discord Bot is running!");
}

main().catch((error) => {
  const msg = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  logger.error("Fatal error", { message: msg, stack });
  process.exit(1);
});
