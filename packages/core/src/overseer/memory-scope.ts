/**
 * The overseer's own memory (overseer memory scope spec 2026-10-07, Unit 1).
 *
 * Claude Code keeps ONE memory folder per project, and every Claude session in that project loads
 * its index at start: the overseer, its agents and the user's own threads. So an overseer used to
 * load the user's thread notes as if they were its own. A Claude overseer now runs with
 * `--settings {"autoMemoryDirectory": <its own folder>}` and loads only that folder; the project's
 * shared folder stays readable on purpose (the persona says when).
 *
 * Every function here takes the home folder as a parameter: tests pass a fs.mkdtempSync folder,
 * and nothing in this module reads os.homedir() itself.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { encodeClaudeProjectDir } from '../platform/encode.js';
import { isUnder, realResolve } from './real-path.js';

/** Where the Claude overseers' own memory folders live, relative to the home folder (POSIX). */
export const OVERSEER_MEMORY_ROOT_REL = '.claude/dispatch-overseer';

/** Written after the one-time copy ends cleanly, so a later start never copies again (see prepareOverseerMemory). */
export const COPY_MARKER = '.dispatch-copy-done';

/** While a copy is cut short by COPY_LIMITS.maxNotes: the last note name handled, so the next start goes on after it. */
export const COPY_CURSOR = '.dispatch-copy-cursor';

/** Bounds of the one-time copy: the bytes read to find a note's origin, the largest note copied, the notes handled per start. */
export const COPY_LIMITS = Object.freeze({ headBytes: 8 * 1024, maxNoteBytes: 1024 * 1024, maxNotes: 500 });

const INDEX = 'MEMORY.md';

const encoded = (projectDir: string) => encodeClaudeProjectDir(projectDir, 'darwin');

/** The Claude overseer's own memory folder: one per project, so a new overseer of the same project keeps it. */
export function overseerMemoryDir(home: string, projectDir: string): string {
  return path.join(home, ...OVERSEER_MEMORY_ROOT_REL.split('/'), encoded(projectDir), 'memory');
}

/**
 * Claude Code's own memory folder for the project: the one every Claude thread in it shares.
 * `projectDir` is the folder Claude keys it by: claudeMemoryProjectDir(the working directory).
 */
export function sharedProjectMemoryDir(home: string, projectDir: string): string {
  return path.join(home, '.claude', 'projects', encoded(projectDir), 'memory');
}

/** The two git paths that locate a repository's main root (see claudeMemoryProjectDir). */
export interface GitRoots { commonDir: string; topLevel: string }

const GIT_TIMEOUT_MS = 2000;

/** The common git dir and the top level of the repository that holds `cwd`; null outside a repository or on any git error. */
export function gitRoots(cwd: string): GitRoots | null {
  // A GIT_DIR/GIT_WORK_TREE in the daemon's environment would point git at another repository.
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) delete env[key];
  try {
    const out = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel'], {
      cwd, env, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const [commonDir, topLevel] = out.split('\n').map((l) => l.trim());
    return commonDir && topLevel && path.isAbsolute(commonDir) && path.isAbsolute(topLevel) ? { commonDir, topLevel } : null;
  } catch {
    return null;
  }
}

/** `p` through symlinks, or `p` itself when it does not resolve. */
function canonical(p: string): string {
  try { return fs.realpathSync.native(p); } catch { return p; }
}

/**
 * The folder Claude Code keys a project's shared memory by. Its documentation: "The `<project>`
 * path is derived from the git repository, so all worktrees and subdirectories within the same
 * repo share one auto memory directory. Outside a git repo, the project root is used instead."
 * So: the main root of the repository that holds `workDir` (the parent of the common `.git` dir,
 * which a worktree shares with the main checkout), else `workDir`. Both through symlinks.
 * When the common dir is not a `.git` folder (a submodule), the repository's top level is used.
 */
export function claudeMemoryProjectDir(workDir: string, roots: (cwd: string) => GitRoots | null = gitRoots): string {
  const dir = canonical(workDir);
  const found = roots(dir);
  if (!found) return dir;
  return canonical(path.basename(found.commonDir) === '.git' ? path.dirname(found.commonDir) : found.topLevel);
}

/** True when `dir` resolves (through symlinks) strictly inside the resolved `root`. */
function resolvesInside(dir: string, root: string): boolean {
  let realRoot: string;
  try { realRoot = realResolve(root); } catch { return false; }
  return isUnder(realRoot, dir);
}

/** The own folder stays inside <home>/.claude/dispatch-overseer, through symlinks. */
export function ownMemoryFolderSafe(home: string, dir: string): boolean {
  return resolvesInside(dir, path.join(home, ...OVERSEER_MEMORY_ROOT_REL.split('/')));
}

/** The shared folder stays inside <home>/.claude/projects, through symlinks. */
export function sharedMemoryFolderSafe(home: string, dir: string): boolean {
  return resolvesInside(dir, path.join(home, '.claude', 'projects'));
}

/** The value of `claude --settings` that points the session's memory at `dir`. A path, not a secret. */
export function autoMemorySettingsArg(dir: string): string {
  return JSON.stringify({ autoMemoryDirectory: dir });
}

/** The `originSessionId` in a note's frontmatter, or null. A key in the body does not count. */
export function noteOriginSessionId(text: string): string | null {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return null;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '---') return null; // end of the frontmatter
    const m = line.match(/^originSessionId:\s*["']?([^"'\s]+)["']?\s*$/);
    if (m) return m[1];
  }
  return null;
}

// Never through a symlink; a FIFO must not block the open.
const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

/** Calls `use` with a plain file's descriptor and size; null when the path is a symlink, not a file, or gone. Other errors throw. */
function withPlainFile<T>(file: string, use: (fd: number, size: number) => T): T | null {
  let fd: number;
  try {
    fd = fs.openSync(file, OPEN_FLAGS);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ELOOP' || code === 'EISDIR') return null;
    throw e;
  }
  try {
    const st = fs.fstatSync(fd);
    return st.isFile() ? use(fd, st.size) : null;
  } finally {
    fs.closeSync(fd);
  }
}

/** The first `max` bytes of the file (fewer when it is shorter). */
function readBytes(fd: number, max: number): Buffer {
  const buf = Buffer.alloc(max);
  let n = 0;
  while (n < max) {
    const r = fs.readSync(fd, buf, n, max - n, n);
    if (r === 0) break;
    n += r;
  }
  return buf.subarray(0, n);
}

// `(name.md)` or `(./name.md)`: a link to a note in the same folder.
const NOTE_LINK = /\((?:\.\/)?([^()/\\]+\.md)\)/g;

function linksOneOf(line: string, names: ReadonlySet<string>): boolean {
  for (const m of line.matchAll(NOTE_LINK)) if (names.has(m[1])) return true;
  return false;
}

/**
 * Adds to the own index the lines of the shared index that link one of `linked`, when the own
 * index does not have them yet. `tooLarge` collects a shared index over the size bound.
 */
function addIndexLines(shared: string, dir: string, linked: ReadonlySet<string>, tooLarge: string[]): void {
  const index = withPlainFile(path.join(shared, INDEX), (fd, size) => {
    if (size > COPY_LIMITS.maxNoteBytes) { tooLarge.push(INDEX); return null; }
    return readBytes(fd, size).toString('utf8');
  });
  if (index === null) return;
  const ownIndex = path.join(dir, INDEX);
  let st: fs.Stats | null = null;
  try { st = fs.lstatSync(ownIndex); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  if (st && !st.isFile()) throw new Error(`${ownIndex} is not a plain file`);
  const have = st ? fs.readFileSync(ownIndex, 'utf8') : '';
  const lines = new Set(have.split(/\r?\n/));
  const add: string[] = [];
  for (const line of index.split(/\r?\n/)) {
    if (lines.has(line) || !linksOneOf(line, linked)) continue;
    lines.add(line);
    add.push(line);
  }
  if (!add.length) return;
  const sep = have && !have.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(ownIndex, `${sep}${add.join('\n')}\n`, { flag: st ? 'a' : 'wx' });
}

function readCursor(dir: string): string {
  try {
    return withPlainFile(path.join(dir, COPY_CURSOR), (fd, size) => readBytes(fd, Math.min(size, 4096)).toString('utf8').trim()) ?? '';
  } catch {
    return '';
  }
}

function writeCursor(dir: string, name: string): void {
  const file = path.join(dir, COPY_CURSOR);
  try { fs.unlinkSync(file); } catch { /* none yet */ }
  fs.writeFileSync(file, `${name}\n`, { flag: 'wx' });
}

/**
 * Creates the overseer's own folder when it is missing, and copies once every note of the shared
 * folder whose `originSessionId` is one of `overseerSessionIds` (this project's overseers, the
 * current one and archived ones), with the lines of the shared index that link those notes. The
 * shared files stay where they are; nothing is deleted, and a file already in the own folder is
 * never overwritten.
 *
 * `projectDir` keys the own folder (the working directory); `sharedProjectDir` keys the shared
 * folder (claudeMemoryProjectDir of the working directory).
 *
 * The copy ends with a marker file, so a later start copies nothing, even when the first start
 * found no notes. The marker is written only when every note was handled without an error; until
 * then each start resumes and copies only what is missing. A start handles at most
 * COPY_LIMITS.maxNotes notes (a cursor file keeps the place), reads at most COPY_LIMITS.headBytes
 * of a note to find its origin, and skips a note over COPY_LIMITS.maxNoteBytes (logged once).
 *
 * `dir` is null when the own folder resolves outside <home>/.claude/dispatch-overseer: then
 * nothing is created or copied. When the shared folder resolves outside <home>/.claude/projects,
 * the own folder is set up and nothing is copied. Returns the notes copied by this start, and
 * whether the copy is done.
 */
export function prepareOverseerMemory(opts: {
  home: string;
  projectDir: string;
  sharedProjectDir: string;
  overseerSessionIds: readonly string[];
}): { dir: string | null; copied: string[]; done: boolean } {
  const dir = overseerMemoryDir(opts.home, opts.projectDir);
  if (!ownMemoryFolderSafe(opts.home, dir)) return { dir: null, copied: [], done: false };
  fs.mkdirSync(dir, { recursive: true });
  const present = new Set(fs.readdirSync(dir));
  if (present.has(COPY_MARKER)) return { dir, copied: [], done: true };

  const shared = sharedProjectMemoryDir(opts.home, opts.sharedProjectDir);
  if (!sharedMemoryFolderSafe(opts.home, shared)) return { dir, copied: [], done: false };
  let names: string[] = [];
  try {
    names = fs.readdirSync(shared);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; // no shared folder yet: nothing to copy
  }

  const cursor = readCursor(dir);
  const todo = names.filter((n) => n !== INDEX && n.endsWith('.md') && n > cursor).sort();
  const batch = todo.slice(0, COPY_LIMITS.maxNotes);
  const ids = new Set(opts.overseerSessionIds.filter(Boolean));
  const linked = new Set<string>(); // the overseer notes of this batch, copied now or before
  const copied: string[] = [];
  const tooLarge: string[] = [];
  let failed = false;
  for (const name of batch) {
    try {
      const bytes = withPlainFile(path.join(shared, name), (fd, size) => {
        if (size > COPY_LIMITS.maxNoteBytes) { tooLarge.push(name); return null; }
        const origin = noteOriginSessionId(readBytes(fd, Math.min(size, COPY_LIMITS.headBytes)).toString('utf8'));
        if (!origin || !ids.has(origin)) return null;
        linked.add(name);
        return present.has(name) ? null : readBytes(fd, size);
      });
      if (bytes === null) continue;
      fs.writeFileSync(path.join(dir, name), bytes, { flag: 'wx' });
      copied.push(name);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') failed = true; // EEXIST: already there, keep it
    }
  }
  if (linked.size) {
    try { addIndexLines(shared, dir, linked, tooLarge); } catch { failed = true; }
  }
  if (tooLarge.length) {
    console.error(`[overseer-memory] the one-time copy skipped ${tooLarge.length} file(s) over 1 MB in ${shared}: ${tooLarge.join(', ')}`);
  }

  if (failed) return { dir, copied, done: false }; // no marker: the next start retries
  if (todo.length > batch.length) {
    writeCursor(dir, batch[batch.length - 1]);
    console.error(`[overseer-memory] the one-time copy handled ${batch.length} of ${todo.length} notes in ${shared}; the next start goes on`);
    return { dir, copied, done: false };
  }
  fs.writeFileSync(path.join(dir, COPY_MARKER), `${JSON.stringify({ copied })}\n`, { flag: 'wx' });
  try { fs.unlinkSync(path.join(dir, COPY_CURSOR)); } catch { /* none */ }
  return { dir, copied, done: true };
}
