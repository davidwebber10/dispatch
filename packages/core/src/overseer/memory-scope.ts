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
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { encodeClaudeProjectDir } from '../platform/encode.js';
import { isUnder, realResolve } from './real-path.js';

/** Where the Claude overseers' own memory folders live, relative to the home folder (POSIX). */
export const OVERSEER_MEMORY_ROOT_REL = '.claude/dispatch-overseer';

/** Written after the one-time copy ends cleanly, so a later start never copies again (see prepareOverseerMemory). */
export const COPY_MARKER = '.dispatch-copy-done';

/**
 * While a copy is cut short by COPY_LIMITS.maxNotes or maxCopyBytes: the exact name of the last
 * note handled, so the next start goes on after it.
 */
export const COPY_CURSOR = '.dispatch-copy-cursor';

/**
 * Bounds of the one-time copy: the bytes read to find a note's origin, the largest note copied,
 * the notes handled per start, the note bytes copied per start, and the largest MEMORY.md read
 * (the shared index and the own index).
 */
export const COPY_LIMITS = Object.freeze({
  headBytes: 8 * 1024,
  maxNoteBytes: 1024 * 1024,
  maxNotes: 500,
  maxCopyBytes: 16 * 1024 * 1024,
  maxIndexBytes: 256 * 1024,
});

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

/**
 * What git says about the folder: inside a repository (its common git dir and top level), not a
 * repository (git says so), or the resolution failed (a timeout, an unreadable or missing folder,
 * a bare repository, any other git error or unexpected output).
 */
export type GitRoots =
  | { kind: 'repo'; commonDir: string; topLevel: string }
  | { kind: 'none' }
  | { kind: 'failed'; reason: string };

const GIT_TIMEOUT_MS = 2000;

/** The first line of git's error output, short enough for one log line. */
function firstLine(text: string): string {
  return text.split('\n').find((l) => l.trim())?.trim().slice(0, 200) ?? '';
}

/** The common git dir and the top level of the repository that holds `cwd` (see GitRoots). */
export function gitRoots(cwd: string): GitRoots {
  // A GIT_DIR/GIT_WORK_TREE in the daemon's environment would point git at another repository.
  // LC_ALL=C: git's "not a git repository" message must not be translated.
  const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: 'C' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'LANGUAGE']) delete env[key];
  const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel'], {
    cwd, env, timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024,
  });
  if (r.error) return { kind: 'failed', reason: (r.error as NodeJS.ErrnoException).code ?? r.error.message };
  if (r.status !== 0) {
    const err = r.stderr.toString('utf8');
    if (/^fatal: not a git repository/m.test(err)) return { kind: 'none' };
    return { kind: 'failed', reason: firstLine(err) || `git exited with ${r.status ?? r.signal}` };
  }
  // The exact path bytes: strip only the one trailing newline, never spaces.
  const out = r.stdout.toString('utf8');
  const lines = out.endsWith('\n') && Buffer.from(out, 'utf8').equals(r.stdout) ? out.slice(0, -1).split('\n') : [];
  if (lines.length !== 2 || !lines.every((l) => path.isAbsolute(l))) return { kind: 'failed', reason: 'unexpected git output' };
  return { kind: 'repo', commonDir: lines[0], topLevel: lines[1] };
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
 * which a worktree shares with the main checkout), else, when git says it is not a repository,
 * `workDir`. Both through symlinks.
 *
 * `dir` is null, with the reason, when the resolution failed, and when the common dir is not
 * named `.git` (a bare repository, a separate git dir, a submodule): Claude's folder for those
 * layouts is not verified, so the caller defers the shared folder to a later start, not guesses.
 */
export function claudeMemoryProjectDir(
  workDir: string,
  roots: (cwd: string) => GitRoots = gitRoots,
): { dir: string; reason?: undefined } | { dir: null; reason: string } {
  const dir = canonical(workDir);
  const found = roots(dir);
  if (found.kind === 'none') return { dir };
  if (found.kind === 'failed') return { dir: null, reason: found.reason };
  if (path.basename(found.commonDir) !== '.git') return { dir: null, reason: `the common git dir is not named .git: ${found.commonDir}` };
  return { dir: canonical(path.dirname(found.commonDir)) };
}

/**
 * True when `dir` resolves (through symlinks) strictly inside `<canonical home/.claude>/<root>`,
 * and `<root>` itself is not a symlink. The anchor is the canonical `.claude`, so a relocated
 * `.claude` (itself a symlink) is followed, but a redirected root is not trusted.
 */
function insideClaudeRoot(home: string, root: string, dir: string): boolean {
  let anchor: string;
  try { anchor = path.join(realResolve(path.join(home, '.claude')), root); } catch { return false; }
  try {
    if (fs.lstatSync(anchor).isSymbolicLink()) return false;
  } catch (e) {
    // Missing: not there yet, so nothing redirects it. Any other error: fail closed.
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return false;
  }
  return isUnder(anchor, dir);
}

/** The own folder stays inside <canonical home/.claude>/dispatch-overseer, through symlinks. */
export function ownMemoryFolderSafe(home: string, dir: string): boolean {
  return insideClaudeRoot(home, path.basename(OVERSEER_MEMORY_ROOT_REL), dir);
}

/** The shared folder stays inside <canonical home/.claude>/projects, through symlinks. */
export function sharedMemoryFolderSafe(home: string, dir: string): boolean {
  return insideClaudeRoot(home, 'projects', dir);
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

/** Returned in place of the bytes of a file that is over a bound of COPY_LIMITS. */
const OVER: unique symbol = Symbol('over a bound');

// `(name.md)` or `(./name.md)`: a link to a note in the same folder.
const NOTE_LINK = /\((?:\.\/)?([^()/\\]+\.md)\)/g;

function linksOneOf(line: string, names: ReadonlySet<string>): boolean {
  for (const m of line.matchAll(NOTE_LINK)) if (names.has(m[1])) return true;
  return false;
}

/**
 * Adds to the own index the lines of the shared index that link one of `linked`, when the own
 * index does not have them yet. `tooLarge` collects an index (shared: its name; own: its path)
 * over COPY_LIMITS.maxIndexBytes, which is not read.
 */
function addIndexLines(shared: string, dir: string, linked: ReadonlySet<string>, tooLarge: string[]): void {
  const index = withPlainFile(path.join(shared, INDEX), (fd, size) => {
    if (size > COPY_LIMITS.maxIndexBytes) { tooLarge.push(INDEX); return null; }
    return readBytes(fd, size).toString('utf8');
  });
  if (index === null) return;
  const ownIndex = path.join(dir, INDEX);
  let st: fs.Stats | null = null;
  try { st = fs.lstatSync(ownIndex); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  if (st && !st.isFile()) throw new Error(`${ownIndex} is not a plain file`);
  let have = '';
  if (st) {
    const text = withPlainFile(ownIndex, (fd, size) => (size > COPY_LIMITS.maxIndexBytes ? OVER : readBytes(fd, size).toString('utf8')));
    if (text === null) throw new Error(`${ownIndex} is not a plain file`);
    if (text === OVER) { tooLarge.push(ownIndex); return; }
    have = text;
  }
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

/**
 * The cursor file: missing, a name (exact: only one trailing newline is stripped), or bad (a
 * folder, a symlink, another file type, or unreadable). A name longer than a file name can be is
 * cut, so it matches no note and is ignored.
 */
type Cursor = { kind: 'none' } | { kind: 'name'; name: string } | { kind: 'bad'; reason: string };

function readCursor(dir: string): Cursor {
  const file = path.join(dir, COPY_CURSOR);
  try {
    if (!fs.lstatSync(file).isFile()) return { kind: 'bad', reason: 'not a plain file' };
    const text = withPlainFile(file, (fd, size) => readBytes(fd, Math.min(size, 4096)).toString('utf8'));
    if (text === null) return { kind: 'bad', reason: 'not a plain file' };
    return { kind: 'name', name: text.endsWith('\n') ? text.slice(0, -1) : text };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ENOENT' ? { kind: 'none' } : { kind: 'bad', reason: code ?? String(e) };
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
 * folder (claudeMemoryProjectDir of the working directory). It is null when that resolution
 * failed: then the own folder is set up, nothing is copied and no marker is written, so the next
 * start tries again.
 *
 * The copy ends with a marker file, so a later start copies nothing, even when the first start
 * found no notes. The marker is written only when every note was handled without an error; until
 * then each start resumes and copies only what is missing. A start handles at most
 * COPY_LIMITS.maxNotes notes and copies at most COPY_LIMITS.maxCopyBytes note bytes (a cursor file
 * keeps the place), reads at most COPY_LIMITS.headBytes of a note to find its origin, skips a note
 * over COPY_LIMITS.maxNoteBytes and an index over COPY_LIMITS.maxIndexBytes (logged once).
 *
 * The cursor counts only when it is the exact name of a note in the shared folder; otherwise the
 * copy starts at the beginning (logged). A cursor path that is not a readable plain file is
 * ignored (logged), and the copy is not marked done while it stays.
 *
 * `dir` is null when the own folder resolves outside <canonical home/.claude>/dispatch-overseer:
 * then nothing is created or copied. When the shared folder resolves outside
 * <canonical home/.claude>/projects, the own folder is set up and nothing is copied. Returns the
 * notes copied by this start, and whether the copy is done.
 */
export function prepareOverseerMemory(opts: {
  home: string;
  projectDir: string;
  sharedProjectDir: string | null;
  overseerSessionIds: readonly string[];
}): { dir: string | null; copied: string[]; done: boolean } {
  const dir = overseerMemoryDir(opts.home, opts.projectDir);
  if (!ownMemoryFolderSafe(opts.home, dir)) return { dir: null, copied: [], done: false };
  fs.mkdirSync(dir, { recursive: true });
  const present = new Set(fs.readdirSync(dir));
  if (present.has(COPY_MARKER)) return { dir, copied: [], done: true };
  if (opts.sharedProjectDir === null) return { dir, copied: [], done: false };

  const shared = sharedProjectMemoryDir(opts.home, opts.sharedProjectDir);
  if (!sharedMemoryFolderSafe(opts.home, shared)) return { dir, copied: [], done: false };
  let names: string[] = [];
  try {
    names = fs.readdirSync(shared);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; // no shared folder yet: nothing to copy
  }

  const notes = names.filter((n) => n !== INDEX && n.endsWith('.md')).sort();
  const cursor = readCursor(dir);
  let from = 0;
  if (cursor.kind === 'bad') {
    console.error(`[overseer-memory] ignored ${path.join(dir, COPY_CURSOR)} (${cursor.reason}): the copy starts at the beginning and is not marked done while it stays`);
  } else if (cursor.kind === 'name') {
    from = notes.indexOf(cursor.name) + 1;
    if (from === 0) console.error(`[overseer-memory] ignored ${path.join(dir, COPY_CURSOR)}: it names no note of ${shared}; the copy starts at the beginning`);
  }
  const todo = notes.slice(from);
  const batch = todo.slice(0, COPY_LIMITS.maxNotes);
  const ids = new Set(opts.overseerSessionIds.filter(Boolean));
  const linked = new Set<string>(); // the overseer notes handled now, copied now or before
  const copied: string[] = [];
  const tooLarge: string[] = [];
  let copiedBytes = 0;
  let handled = 0;
  let failed = false;
  for (; handled < batch.length; handled++) {
    const name = batch[handled];
    try {
      const bytes = withPlainFile(path.join(shared, name), (fd, size) => {
        if (size > COPY_LIMITS.maxNoteBytes) { tooLarge.push(name); return null; }
        const origin = noteOriginSessionId(readBytes(fd, Math.min(size, COPY_LIMITS.headBytes)).toString('utf8'));
        if (!origin || !ids.has(origin)) return null;
        if (present.has(name)) { linked.add(name); return null; }
        // The byte bound of a start; the first note of a start always goes, so each start moves on.
        if (copiedBytes > 0 && copiedBytes + size > COPY_LIMITS.maxCopyBytes) return OVER;
        linked.add(name);
        return readBytes(fd, size);
      });
      if (bytes === OVER) break; // this note and the rest wait for the next start
      if (bytes === null) continue;
      fs.writeFileSync(path.join(dir, name), bytes, { flag: 'wx' });
      copied.push(name);
      copiedBytes += bytes.length;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') failed = true; // EEXIST: already there, keep it
    }
  }
  if (linked.size) {
    try { addIndexLines(shared, dir, linked, tooLarge); } catch { failed = true; }
  }
  if (tooLarge.length) {
    console.error(
      `[overseer-memory] the one-time copy skipped ${tooLarge.length} file(s) over their size bound (a note 1 MB, MEMORY.md 256 KB) in ${shared}: ${tooLarge.join(', ')}`,
    );
  }

  if (failed || cursor.kind === 'bad') return { dir, copied, done: false }; // no marker: the next start retries
  if (handled < todo.length) {
    writeCursor(dir, todo[handled - 1]);
    console.error(`[overseer-memory] the one-time copy handled ${handled} of ${todo.length} notes in ${shared}; the next start goes on`);
    return { dir, copied, done: false };
  }
  fs.writeFileSync(path.join(dir, COPY_MARKER), `${JSON.stringify({ copied })}\n`, { flag: 'wx' });
  try { fs.unlinkSync(path.join(dir, COPY_CURSOR)); } catch { /* none */ }
  return { dir, copied, done: true };
}
