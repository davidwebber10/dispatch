/**
 * The diff of a thread's working directory against `HEAD` (engineering program W3-G).
 *
 * Read only. Paths are relative to the working directory, and only files in that directory are listed
 * (`--relative`): a thread whose directory is a folder of a larger repository reviews its own folder.
 * `--no-ext-diff --no-textconv`: a repository's config cannot make the daemon run a diff program.
 */
import fs from 'node:fs';
import path from 'node:path';
import { git, gitOrNull, GitFailed, repoFiltersOff, type ConfigPair } from './exec.js';
import { checkRelPath, confine, realDir, PathRefused } from './paths.js';
import { holdsSecret, type SecretRoots } from '../files/secret-paths.js';

export type DiffStatus = 'added' | 'modified' | 'deleted' | 'untracked' | 'renamed';

export interface DiffFile {
  path: string;
  status: DiffStatus;
  additions: number;
  deletions: number;
  patch?: string;
  /** A rename: the path in HEAD. */
  oldPath?: string;
  /** True when the whole change is in the index (Approve was used, or `git add`). */
  staged: boolean;
  binary?: boolean;
  /** The patch text was cut at the size cap. */
  patchCut?: boolean;
  /** Why there is no patch text: over the size cap, a credentials path, or a folder with its own repository. */
  patchOmitted?: 'large' | 'secret' | 'directory';
}

export interface ThreadDiff {
  files: DiffFile[];
  /** Some patch text, or part of the list, was left out. */
  truncated: boolean;
  /** Other live threads use this directory: the changes can come from more than one thread. */
  shared: boolean;
  /** False when the directory is not in a git repository. */
  repo: boolean;
  branch: string | null;
  workDir: string;
}

export interface ThreadDiffOptions {
  /** Only this file (a path relative to the working directory). */
  path?: string;
  /** The cap on all patch text together. */
  maxBytes?: number;
  /** The working directories of the live threads (one entry for each thread). */
  liveDirs?: string[];
  secretRoots?: SecretRoots;
}

/** One changed file, with no patch text. `directory` marks an untracked folder that holds its own repository. */
export interface Change { path: string; status: DiffStatus; oldPath?: string; additions: number; deletions: number; binary: boolean; staged: boolean; directory?: boolean }

export const DEFAULT_MAX_BYTES = 512 * 1024;
/** The list is cut here: a directory with more changed files than this is not a review, it is a build folder. */
export const MAX_FILES = 2000;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const UNTRACKED_READ_CAP = 1024 * 1024;
const PATCH_FLAGS = ['--no-ext-diff', '--no-textconv', '--no-color', '--relative', '-M'];

/** The commit to compare against: `HEAD`, or the empty tree in a repository with no commit yet. */
async function baseOf(dir: string): Promise<string> {
  if (await gitOrNull(dir, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])) return 'HEAD';
  return (await gitOrNull(dir, ['hash-object', '-t', 'tree', '/dev/null']))?.trim() || EMPTY_TREE;
}

export async function isRepo(dir: string): Promise<boolean> {
  return (await gitOrNull(dir, ['rev-parse', '--is-inside-work-tree']))?.trim() === 'true';
}

const STATUS: Record<string, DiffStatus> = { A: 'added', D: 'deleted', M: 'modified', T: 'modified', U: 'modified', R: 'renamed', C: 'added' };

/** Parse `--name-status -z`: `M\0path\0`, and for a rename `R100\0old\0new\0`. */
function parseNameStatus(out: string): Array<{ path: string; status: DiffStatus; oldPath?: string }> {
  const f = out.split('\0');
  const res: Array<{ path: string; status: DiffStatus; oldPath?: string }> = [];
  for (let i = 0; i + 1 < f.length;) {
    const code = f[i][0];
    if (code === 'R' || code === 'C') {
      if (i + 2 >= f.length) break;
      res.push(code === 'R' ? { status: 'renamed', oldPath: f[i + 1], path: f[i + 2] } : { status: 'added', path: f[i + 2] });
      i += 3;
    } else {
      res.push({ status: STATUS[code] ?? 'modified', path: f[i + 1] });
      i += 2;
    }
  }
  return res;
}

/** Parse `--numstat -z`: `a\td\tpath\0`, and for a rename `a\td\t\0old\0new\0`. A binary file has `-` for both. */
function parseNumstat(out: string): Map<string, { additions: number; deletions: number; binary: boolean }> {
  const f = out.split('\0');
  const res = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  for (let i = 0; i < f.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(f[i]);
    if (!m) continue;
    let p = m[3];
    if (p === '') { p = f[i + 2] ?? ''; i += 2; }
    res.set(p, { additions: m[1] === '-' ? 0 : Number(m[1]), deletions: m[2] === '-' ? 0 : Number(m[2]), binary: m[1] === '-' });
  }
  return res;
}

const zList = (out: string): string[] => out.split('\0').filter((p) => p !== '');

/**
 * Every changed file of the directory, with counts and no patch text: tracked changes against HEAD (staged or
 * not), then the untracked files that no ignore rule covers. Throws `GitFailed` when the directory is not a repository.
 */
export async function listChanges(workDir: string, filtersOff?: ConfigPair[]): Promise<Change[]> {
  const base = await baseOf(workDir);
  const scope = ['--no-ext-diff', '--no-textconv', '--relative', '-M', '-z'];
  // No filter command of the repository's own config runs for a look at the diff (exec.ts, repoFiltersOff).
  const config = filtersOff ?? await repoFiltersOff(workDir);
  const [names, nums, unstaged, others] = await Promise.all([
    git(workDir, ['diff', base, ...scope, '--name-status'], { config }),
    git(workDir, ['diff', base, ...scope, '--numstat'], { config }),
    git(workDir, ['diff', '--no-ext-diff', '--no-textconv', '--relative', '-z', '--name-only'], { config }),
    git(workDir, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  const counts = parseNumstat(nums);
  const notStaged = new Set(zList(unstaged));
  const changes: Change[] = parseNameStatus(names).map((n) => {
    const c = counts.get(n.path) ?? { additions: 0, deletions: 0, binary: false };
    return { ...n, ...c, staged: !notStaged.has(n.path) && !(n.oldPath && notStaged.has(n.oldPath)) };
  });
  const tracked = new Set(changes.map((c) => c.path));
  for (const p of zList(others)) {
    if (tracked.has(p)) continue;
    // A trailing slash: git names a folder with its own repository as one entry and does not look inside.
    if (p.endsWith('/')) changes.push({ path: p, status: 'untracked', additions: 0, deletions: 0, binary: false, staged: false, directory: true });
    else changes.push({ path: p, status: 'untracked', additions: 0, deletions: 0, binary: false, staged: false });
  }
  return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Cut `text` to at most `max` bytes, at a line end. */
function cutAtLine(text: string, max: number): string {
  if (max <= 0) return '';
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= max) return text;
  const nl = buf.lastIndexOf(0x0a, max - 1);
  return nl < 0 ? '' : buf.subarray(0, nl + 1).toString('utf8');
}

/** The patch body: from the first hunk header on. The `diff --git` header lines repeat what the row already says. */
function hunksOf(patch: string): string {
  const at = patch.search(/^@@ /m);
  return at < 0 ? '' : patch.slice(at);
}

interface Loaded { patch?: string; additions?: number; binary?: boolean; omitted?: DiffFile['patchOmitted'] }

/** An untracked file as an all-added patch. Read with `O_NOFOLLOW`: a symbolic link is described, never followed. */
async function loadUntracked(abs: string, cap: number): Promise<Loaded> {
  let st: fs.Stats;
  try { st = await fs.promises.lstat(abs); } catch { return {}; }
  if (st.isSymbolicLink()) {
    let target = '';
    try { target = await fs.promises.readlink(abs); } catch { /* unreadable link */ }
    return { patch: `@@ -0,0 +1 @@\n+(symbolic link to ${target})\n`, additions: 1 };
  }
  if (!st.isFile()) return { omitted: 'directory' };
  if (st.size > Math.min(cap, UNTRACKED_READ_CAP)) return { omitted: 'large' };
  let buf: Buffer;
  try {
    const fh = await fs.promises.open(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try { buf = await fh.readFile(); } finally { await fh.close(); }
  } catch { return {}; }
  if (buf.subarray(0, 8000).includes(0)) return { binary: true };
  const text = buf.toString('utf8');
  if (text === '') return { patch: '', additions: 0 };
  const noEol = !text.endsWith('\n');
  const lines = (noEol ? text : text.slice(0, -1)).split('\n');
  return {
    patch: `@@ -0,0 +1${lines.length === 1 ? '' : `,${lines.length}`} @@\n${lines.map((l) => `+${l}`).join('\n')}\n${noEol ? '\\ No newline at end of file\n' : ''}`,
    additions: lines.length,
  };
}

async function loadTracked(workDir: string, base: string, c: Change, cap: number, config: ConfigPair[]): Promise<Loaded> {
  try {
    const out = await git(workDir, ['diff', base, ...PATCH_FLAGS, '--', ...(c.oldPath ? [c.oldPath] : []), c.path], { maxBuffer: Math.max(cap * 2, 4 * 1024 * 1024), config });
    return { patch: hunksOf(out) };
  } catch (e) {
    if (e instanceof GitFailed && e.overflow) return { omitted: 'large' };
    return {};
  }
}

async function isSecret(workDir: string, rel: string, roots: SecretRoots | undefined): Promise<boolean> {
  if (!roots) return false;
  // The text and the identity of the file (v4.5.0 review, I4): the patch of a new file carries its content, so a
  // hard link in the repository to a secret file must not get a patch. An error of the check omits the patch.
  return holdsSecret(path.join(realDir(workDir), ...rel.split('/')), roots).catch(() => true);
}

export async function threadDiff(workDir: string, opts: ThreadDiffOptions = {}): Promise<ThreadDiff> {
  const real = realDir(workDir);
  const shared = (opts.liveDirs ?? []).filter((d) => realDir(d) === real).length > 1;
  if (!(await isRepo(workDir))) return { files: [], truncated: false, shared, repo: false, branch: null, workDir };
  const branch = (await gitOrNull(workDir, ['symbolic-ref', '--quiet', '--short', 'HEAD']))?.trim() || null;
  const base = await baseOf(workDir);
  const filtersOff = await repoFiltersOff(workDir);
  let changes = await listChanges(workDir, filtersOff);
  let truncated = false;
  if (opts.path !== undefined) {
    try { checkRelPath(opts.path); } catch (e) { if (e instanceof PathRefused) return { files: [], truncated: false, shared, repo: true, branch, workDir }; throw e; }
    changes = changes.filter((c) => c.path === opts.path);
  }
  if (changes.length > MAX_FILES) { changes = changes.slice(0, MAX_FILES); truncated = true; }

  let budget = Math.max(0, opts.maxBytes ?? DEFAULT_MAX_BYTES);
  const files: DiffFile[] = [];
  for (const c of changes) {
    const file: DiffFile = { path: c.path, status: c.status, additions: c.additions, deletions: c.deletions, staged: c.staged, ...(c.oldPath ? { oldPath: c.oldPath } : {}), ...(c.binary ? { binary: true } : {}) };
    files.push(file);
    if (c.directory) { file.patchOmitted = 'directory'; continue; }
    if (c.binary) continue;
    if (await isSecret(workDir, c.path, opts.secretRoots)) { file.patchOmitted = 'secret'; continue; }
    if (budget <= 0) { truncated = true; file.patchOmitted = 'large'; continue; }
    let loaded: Loaded;
    if (c.status === 'untracked') {
      let abs: string;
      try { abs = await confine(workDir, c.path); } catch { continue; }
      loaded = await loadUntracked(abs, budget);
      if (loaded.additions !== undefined) file.additions = loaded.additions;
      if (loaded.binary) file.binary = true;
    } else {
      loaded = await loadTracked(workDir, base, c, budget, filtersOff);
    }
    if (loaded.omitted) { file.patchOmitted = loaded.omitted; if (loaded.omitted === 'large') truncated = true; continue; }
    if (loaded.patch === undefined) continue;
    const cut = cutAtLine(loaded.patch, budget);
    if (cut.length < loaded.patch.length) { file.patchCut = true; truncated = true; }
    file.patch = cut;
    budget -= Buffer.byteLength(cut, 'utf8');
    if (file.patchCut) budget = 0;
  }
  return { files, truncated, shared, repo: true, branch, workDir };
}
