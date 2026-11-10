/**
 * How the diff review and the thread worktrees run git (engineering program W3-G).
 *
 * - `execFile` with an argument array: no shell, so no path or name is ever read as shell text.
 * - `core.fsmonitor=false`: a repository's own config cannot make the daemon run a command (see docs/git.ts).
 * - `--literal-pathspecs`: a path is a path. `*`, `:/`, `:(glob)` and every other pathspec magic are off, so a
 *   path that names one file can never widen to many.
 * - The `GIT_*` location variables of the daemon's own environment are dropped: `-C dir` alone picks the repository.
 * - A read of the diff turns off the filter commands that the repository's own config defines (`repoFiltersOff`).
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
  /**
   * Config for this one call, as key and value. It goes through the environment (`GIT_CONFIG_KEY_n`), not `-c`:
   * a key with `=` in it (a filter name can have one) stays one key.
   */
  config?: ConfigPair[];
}

export type ConfigPair = [key: string, value: string];

function gitEnv(config: ConfigPair[] = []): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX', 'GIT_NAMESPACE', 'GIT_LITERAL_PATHSPECS', 'GIT_GLOB_PATHSPECS']) delete env[k];
  if (config.length > 0) {
    // After the pairs that the daemon's own environment already holds: a later pair wins.
    const have = Number(env.GIT_CONFIG_COUNT);
    const first = Number.isInteger(have) && have > 0 ? have : 0;
    config.forEach(([key, value], i) => { env[`GIT_CONFIG_KEY_${first + i}`] = key; env[`GIT_CONFIG_VALUE_${first + i}`] = value; });
    env.GIT_CONFIG_COUNT = String(first + config.length);
  }
  return env;
}

/** Run `git -C dir ...args`. Resolves with stdout; rejects with `GitFailed` (the stderr text is in the message). */
export function git(dir: string, args: string[], opts: GitOptions = {}): Promise<string> {
  const argv = [...GIT_NO_FSMONITOR, ...(opts.write ? [] : ['--no-optional-locks']), ...(opts.plainPathspecs ? [] : ['--literal-pathspecs']), '-C', dir, ...args];
  return new Promise((resolve, reject) => {
    execFile('git', argv, { timeout: opts.timeoutMs ?? GIT_TIMEOUT_MS, maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER, env: gitEnv(opts.config), encoding: 'utf8' }, (err, stdout, stderr) => {
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

/** What `git lfs install` writes. A repository that holds exactly these runs the user's own git-lfs, as every git command there does. */
const LFS_COMMANDS: Record<string, string> = { clean: 'git-lfs clean -- %f', smudge: 'git-lfs smudge -- %f', process: 'git-lfs filter-process' };

/**
 * The config that turns off the filter commands of the repository's OWN config (v4.5.0 review), for `opts.config`
 * of a read. Empty for a repository that defines none: the usual case.
 *
 * `git diff` cleans each changed file with the filter that the attributes name before it compares, and the command
 * of a filter is config text. The config of a repository (`.git/config`, a file it includes, the config of a
 * worktree) is written by whoever made the folder, so a look at the diff must not run it: the same rule as
 * `core.fsmonitor`. The user's global and system config are the user's own and stay. So do the three commands of
 * git-lfs, word for word: a repository after `git lfs install --local` keeps its normal diff.
 *
 * A git older than 2.26 has no `--show-scope`: the list is empty there and the diff runs as before.
 *
 * With a filter off, a changed file of that filter is compared as it is on the disk (a file of git-crypt reads as
 * changed binary content). Approve and Discard still run the filters: `git add` and `git restore` must store and
 * write the content the way the repository asks, and they run on a press of the owner, not on a look.
 */
export async function repoFiltersOff(dir: string): Promise<ConfigPair[]> {
  const out = await gitOrNull(dir, ['config', '--show-scope', '-z', '--get-regexp', '^filter\\..*\\.(clean|smudge|process)$']);
  if (!out) return [];
  // `scope NUL key LF value NUL`, repeated.
  const parts = out.split('\0');
  const names = new Set<string>();
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (parts[i] !== 'local' && parts[i] !== 'worktree') continue;
    const nl = parts[i + 1].indexOf('\n');
    const key = nl < 0 ? parts[i + 1] : parts[i + 1].slice(0, nl);
    const value = nl < 0 ? '' : parts[i + 1].slice(nl + 1);
    const dot = key.lastIndexOf('.');
    if (LFS_COMMANDS[key.slice(dot + 1)] === value) continue;
    names.add(key.slice('filter.'.length, dot));
  }
  return [...names].flatMap((n): ConfigPair[] => [[`filter.${n}.clean`, ''], [`filter.${n}.smudge`, ''], [`filter.${n}.process`, ''], [`filter.${n}.required`, 'false']]);
}

/** True when git could not take `index.lock`: another git command runs in the directory right now. */
export function isLockError(e: unknown): boolean {
  return e instanceof GitFailed && /index\.lock|Unable to create .*\.lock/i.test(e.stderr);
}
