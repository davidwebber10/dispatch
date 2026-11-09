/**
 * How the diff review and the thread worktrees run git (engineering program W3-G).
 *
 * - `execFile` with an argument array: no shell, so no path or name is ever read as shell text.
 * - `core.fsmonitor=false`: a repository's own config cannot make the daemon run a command (see docs/git.ts).
 * - `--literal-pathspecs`: a path is a path. `*`, `:/`, `:(glob)` and every other pathspec magic are off, so a
 *   path that names one file can never widen to many.
 * - The `GIT_*` location variables of the daemon's own environment are dropped: `-C dir` alone picks the repository.
 */
import { execFile } from 'node:child_process';
import { GIT_NO_FSMONITOR } from '../docs/git.js';

export const GIT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

export class GitFailed extends Error {
  constructor(message: string, readonly exitCode: number | null, readonly stderr: string, readonly overflow = false) { super(message); this.name = 'GitFailed'; }
}

export interface GitOptions {
  /** A read takes no optional lock, so an agent's own `git commit` in the same directory never fails on it. */
  write?: boolean;
  maxBuffer?: number;
  timeoutMs?: number;
  /** Leave `--literal-pathspecs` out, for the few commands that refuse it (`check-ignore`). Only with a path the daemon built. */
  plainPathspecs?: boolean;
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX', 'GIT_NAMESPACE', 'GIT_LITERAL_PATHSPECS', 'GIT_GLOB_PATHSPECS']) delete env[k];
  return env;
}

/** Run `git -C dir ...args`. Resolves with stdout; rejects with `GitFailed` (the stderr text is in the message). */
export function git(dir: string, args: string[], opts: GitOptions = {}): Promise<string> {
  const argv = [...GIT_NO_FSMONITOR, ...(opts.write ? [] : ['--no-optional-locks']), ...(opts.plainPathspecs ? [] : ['--literal-pathspecs']), '-C', dir, ...args];
  return new Promise((resolve, reject) => {
    execFile('git', argv, { timeout: opts.timeoutMs ?? GIT_TIMEOUT_MS, maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER, env: gitEnv(), encoding: 'utf8' }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      const e = err as NodeJS.ErrnoException & { code?: number | string };
      const overflow = e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
      const text = String(stderr || e.message || '').trim();
      reject(new GitFailed(text.split('\n').slice(0, 4).join(' ').slice(0, 500) || 'git failed', typeof e.code === 'number' ? e.code : null, text, overflow));
    });
  });
}

/** Like `git`, but null on any failure (not a repository, no such ref). */
export async function gitOrNull(dir: string, args: string[], opts: GitOptions = {}): Promise<string | null> {
  try { return await git(dir, args, opts); } catch { return null; }
}

/** True when git could not take `index.lock`: another git command runs in the directory right now. */
export function isLockError(e: unknown): boolean {
  return e instanceof GitFailed && /index\.lock|Unable to create .*\.lock/i.test(e.stderr);
}
