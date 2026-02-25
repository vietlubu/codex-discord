import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const DEFAULT_RETRIES = 20;
const DEFAULT_RETRY_MS = 100;

interface LockMetadata {
  pid: number;
  token: string;
}

export class ProcessAlreadyRunningError extends Error {
  constructor(
    public readonly lockPath: string,
    public readonly ownerPid: number | null,
  ) {
    super(
      ownerPid
        ? `Another bot instance is already running (PID ${ownerPid}).`
        : "Another bot instance is already running.",
    );
    this.name = "ProcessAlreadyRunningError";
  }
}

export interface ProcessLock {
  lockPath: string;
  release(): Promise<void>;
  releaseSync(): void;
}

interface AcquireProcessLockOptions {
  retries?: number;
  retryMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function parseLockMetadata(raw: string): LockMetadata | null {
  try {
    const parsed = JSON.parse(raw) as Partial<LockMetadata>;
    if (
      typeof parsed.pid === "number" &&
      Number.isInteger(parsed.pid) &&
      parsed.pid > 0 &&
      typeof parsed.token === "string" &&
      parsed.token.length > 0
    ) {
      return { pid: parsed.pid, token: parsed.token };
    }
  } catch {
    // Ignore malformed lock content.
  }

  const pid = Number.parseInt(raw.trim(), 10);
  if (Number.isInteger(pid) && pid > 0) {
    return { pid, token: "" };
  }

  return null;
}

async function readLockMetadata(lockPath: string): Promise<LockMetadata | null> {
  try {
    const raw = await readFile(lockPath, "utf8");
    return parseLockMetadata(raw);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    return null;
  }
}

function readLockMetadataSync(lockPath: string): LockMetadata | null {
  try {
    const raw = readFileSync(lockPath, "utf8");
    return parseLockMetadata(raw);
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

async function removeLockIfStale(lockPath: string): Promise<LockMetadata | null> {
  const lock = await readLockMetadata(lockPath);
  if (!lock) {
    await rm(lockPath, { force: true }).catch(() => {});
    return null;
  }

  if (!isProcessAlive(lock.pid)) {
    await rm(lockPath, { force: true }).catch(() => {});
    return null;
  }

  return lock;
}

export async function acquireProcessLock(
  lockPath: string,
  options: AcquireProcessLockOptions = {},
): Promise<ProcessLock> {
  const retries = options.retries ?? DEFAULT_RETRIES;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const resolvedLockPath = resolve(lockPath);

  await mkdir(dirname(resolvedLockPath), { recursive: true });

  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let ownerPid: number | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const handle = await open(resolvedLockPath, "wx");
      try {
        await handle.writeFile(
          JSON.stringify({
            pid: process.pid,
            token,
            startedAt: new Date().toISOString(),
            cwd: process.cwd(),
          }),
          "utf8",
        );
      } catch (writeError) {
        await handle.close().catch(() => {});
        await rm(resolvedLockPath, { force: true }).catch(() => {});
        throw writeError;
      }

      let released = false;

      const release = async (): Promise<void> => {
        if (released) return;
        released = true;

        await handle.close().catch(() => {});

        const current = await readLockMetadata(resolvedLockPath);
        if (current?.pid === process.pid && current.token === token) {
          await rm(resolvedLockPath, { force: true }).catch(() => {});
        }
      };

      const releaseSync = (): void => {
        if (released) return;
        released = true;

        const current = readLockMetadataSync(resolvedLockPath);
        if (
          existsSync(resolvedLockPath) &&
          current?.pid === process.pid &&
          current.token === token
        ) {
          try {
            rmSync(resolvedLockPath, { force: true });
          } catch {
            // Ignore lock cleanup errors during process exit.
          }
        }
      };

      return {
        lockPath: resolvedLockPath,
        release,
        releaseSync,
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw error;
      }

      const lock = await removeLockIfStale(resolvedLockPath);
      ownerPid = lock?.pid ?? null;

      if (!lock) {
        continue;
      }

      if (attempt === retries) {
        throw new ProcessAlreadyRunningError(resolvedLockPath, ownerPid);
      }

      await sleep(retryMs);
    }
  }

  throw new ProcessAlreadyRunningError(resolvedLockPath, ownerPid);
}
