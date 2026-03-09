import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

const CODEX_WORKTREES_ROOT = `${join(homedir(), ".codex", "worktrees")}${sep}`;

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

/**
 * Stable identity used to map root paths and Codex worktrees to the same project.
 */
export function getProjectKey(path: string): string {
  return basename(canonicalizeProjectPath(path));
}

function isCodexWorktreePath(path: string): boolean {
  return canonicalizeProjectPath(path).startsWith(CODEX_WORKTREES_ROOT);
}

/**
 * Prefer the non-worktree path when the same project appears from both root and worktree.
 */
export function pickPreferredProjectPath(currentPath: string, candidatePath: string): string {
  const current = canonicalizeProjectPath(currentPath);
  const candidate = canonicalizeProjectPath(candidatePath);

  if (current === candidate) return current;

  const currentExists = existsSync(current);
  const candidateExists = existsSync(candidate);

  if (currentExists !== candidateExists) {
    return candidateExists ? candidate : current;
  }

  const currentIsWorktree = isCodexWorktreePath(current);
  const candidateIsWorktree = isCodexWorktreePath(candidate);

  if (currentIsWorktree !== candidateIsWorktree) {
    return candidateIsWorktree ? current : candidate;
  }

  return current;
}
