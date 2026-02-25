import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Normalize a project path so all flows (CLI/App/manual setup) use one stable key.
 * Falls back to resolved path if realpath cannot be resolved yet.
 */
export function canonicalizeProjectPath(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}
