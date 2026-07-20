import fs from 'fs';
import os from 'os';
import path from 'path';
import { encodeClaudeProjectDir } from '../platform/encode.js';

/**
 * Locates a Claude Code session's transcript JSONL.
 *
 * Every reader of a transcript used to derive its path the same way — encode the thread's
 * `working_dir`, join the session id — and treat a failed read as "no history." That is
 * wrong whenever the file isn't where the working dir says it should be, and the chat then
 * rendered completely empty while the same thread's PTY scrollback (replayed from Dispatch's
 * own buffer, not the transcript) looked perfectly healthy.
 *
 * Two independent ways the computed path goes wrong, both observed locally:
 *
 *  1. **Encoding.** Fixed in platform/encode.ts — a dot-directory (`<repo>/.claude/worktrees/x`)
 *     used to encode to a folder that never exists.
 *
 *  2. **Relocation.** A session that changes cwd — `EnterWorktree` above all — keeps its
 *     session id but Claude Code continues writing it under the NEW cwd's project directory.
 *     Dispatch's stored `working_dir` still points at wherever the thread spawned, so the
 *     computed directory is stale for the rest of the session's life. No encoder can fix
 *     this: the file genuinely is not under the working dir. Claude Code does write
 *     `{"type":"relocated","relocatedCwd":…}` markers, but they live INSIDE the destination
 *     file — useless for finding it — so the only reliable resolution is to search by
 *     session id, which is a uuid and therefore unambiguous.
 *
 * The working dir is always tried first, so the overwhelmingly common case costs one
 * `existsSync` and the search never runs. A resolved path is memoized because the search
 * stats every project directory, and revalidated on every hit so a deleted or rotated
 * transcript can't be served from a stale entry.
 */

/** sessionId -> last known transcript path. Revalidated on read (see resolveTranscriptPath). */
const cache = new Map<string, string>();

/** Drops all memoized resolutions. Exposed for tests. */
export function clearTranscriptPathCache(): void {
  cache.clear();
}

/** The default transcript store, `~/.claude/projects`. */
export function claudeProjectsRoot(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * The absolute path to `sessionId`'s transcript, or undefined when it exists nowhere under
 * `projectsRoot`. Never throws — an unreadable store resolves to undefined, and callers
 * treat that the same as they always treated a failed read.
 */
export function resolveTranscriptPath(
  workDir: string,
  sessionId: string,
  projectsRoot: string = claudeProjectsRoot(),
): string | undefined {
  if (!sessionId) return undefined;
  const file = `${sessionId}.jsonl`;

  // 1. Where the working dir says it should be. Checked BEFORE the cache: it's a single
  //    stat, and it keeps a relocated-then-returned session honest.
  if (workDir) {
    const direct = path.join(projectsRoot, encodeClaudeProjectDir(workDir, 'darwin'), file);
    if (exists(direct)) { cache.set(sessionId, direct); return direct; }
  }

  // 2. A previously-found location, revalidated so a removed file doesn't linger.
  const cached = cache.get(sessionId);
  if (cached !== undefined) {
    if (exists(cached)) return cached;
    cache.delete(sessionId);
  }

  // 3. Search every project directory. Only reached when the thread's working dir is not
  //    where the session actually ended up — i.e. it relocated.
  let dirs: string[];
  try { dirs = fs.readdirSync(projectsRoot); } catch { return undefined; }
  for (const d of dirs) {
    const candidate = path.join(projectsRoot, d, file);
    if (exists(candidate)) { cache.set(sessionId, candidate); return candidate; }
  }
  return undefined;
}

function exists(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}
