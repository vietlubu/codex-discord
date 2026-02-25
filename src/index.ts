import { loadConfig } from "./config/index.js";
import { initDatabase } from "./storage/database.js";
import { DiscordBot } from "./bot/client.js";
import { logger } from "./utils/logger.js";
import { acquireProcessLock, ProcessAlreadyRunningError } from "./utils/process-lock.js";

async function main(): Promise<void> {
  logger.info("Starting Codex Discord Bot...");

  // Load configuration
  const config = loadConfig();
  const lock = await acquireProcessLock(`${config.database.path}.lock`);
  logger.info("Acquired process lock", { lockPath: lock.lockPath, pid: process.pid });

  let bot: DiscordBot | null = null;
  let shuttingDown = false;

  const releaseLock = async (): Promise<void> => {
    await lock.release();
    logger.info("Released process lock", { lockPath: lock.lockPath, pid: process.pid });
  };

  // Graceful shutdown
  const shutdown = async (signal: string, exitCode = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info(`Received ${signal}, shutting down...`);

    try {
      if (bot) {
        await bot.stop();
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      logger.error("Error while stopping bot", { message: msg, stack });
      exitCode = 1;
    }

    try {
      await releaseLock();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      logger.error("Error while releasing process lock", { message: msg, stack });
      exitCode = 1;
    }

    process.exit(exitCode);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("uncaughtException", (error) => {
    const msg = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    logger.error("Uncaught exception", { message: msg, stack });
    void shutdown("uncaughtException", 1);
  });
  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    logger.error("Unhandled rejection", { message: msg, stack });
    void shutdown("unhandledRejection", 1);
  });
  process.on("exit", () => {
    lock.releaseSync();
  });

  try {
    // Initialize database
    await initDatabase(config.database.path);

    // Start Discord bot
    bot = new DiscordBot(config);
    await bot.start();
  } catch (error) {
    await releaseLock().catch(() => {});
    throw error;
  }

  logger.info("Codex Discord Bot is running!");
}

main().catch((error) => {
  if (error instanceof ProcessAlreadyRunningError) {
    logger.error(error.message, { lockPath: error.lockPath, ownerPid: error.ownerPid });
    process.exit(1);
    return;
  }

  const msg = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  logger.error("Fatal error", { message: msg, stack });
  process.exit(1);
});
