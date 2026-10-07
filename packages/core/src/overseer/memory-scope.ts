/**
 * The overseer's own memory (overseer memory scope spec 2026-10-07, Unit 1).
 *
 * Claude Code keeps ONE memory folder per project directory, and every Claude session in that
 * directory loads its index at start: the overseer, its agents and the user's own threads. So an
 * overseer used to load the user's thread notes as if they were its own. A Claude overseer now
 * runs with `--settings {"autoMemoryDirectory": <its own folder>}` and loads only that folder; the
 * project's shared folder stays readable on purpose (the persona says when).
 *
 * Every function here takes the home folder as a parameter: tests pass a fs.mkdtempSync folder,
 * and nothing in this module reads os.homedir() itself.
 */
import fs from 'node:fs';
import path from 'node:path';
import { encodeClaudeProjectDir } from '../platform/encode.js';

/** Where the Claude overseers' own memory folders live, relative to the home folder (POSIX). */
export const OVERSEER_MEMORY_ROOT_REL = '.claude/dispatch-overseer';

/** Written after the one-time copy, so a later start never copies again (see prepareOverseerMemory). */
export const COPY_MARKER = '.dispatch-copy-done';

const INDEX = 'MEMORY.md';

const encoded = (projectDir: string) => encodeClaudeProjectDir(projectDir, 'darwin');

/** The Claude overseer's own memory folder: one per project, so a new overseer of the same project keeps it. */
export function overseerMemoryDir(home: string, projectDir: string): string {
  return path.join(home, ...OVERSEER_MEMORY_ROOT_REL.split('/'), encoded(projectDir), 'memory');
}

/** Claude Code's own memory folder for the project: the one every Claude thread in it shares. */
export function sharedProjectMemoryDir(home: string, projectDir: string): string {
  return path.join(home, '.claude', 'projects', encoded(projectDir), 'memory');
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

/** A regular file directly in `dir` (never a symlink or a folder). */
function isPlainFile(dir: string, name: string): boolean {
  try { return fs.lstatSync(path.join(dir, name)).isFile(); } catch { return false; }
}

/**
 * Creates the overseer's own folder when it is missing. When the folder is empty, copies once
 * every note of the shared folder whose `originSessionId` is one of `overseerSessionIds` (this
 * project's overseers, the current one and archived ones), and the lines of the shared index that
 * link those notes. The shared files stay where they are; nothing is deleted.
 *
 * A marker file records the copy, so a second start copies nothing, even when the first start
 * found no notes. Returns the names of the copied notes.
 */
export function prepareOverseerMemory(opts: {
  home: string;
  projectDir: string;
  overseerSessionIds: readonly string[];
}): { dir: string; copied: string[] } {
  const dir = overseerMemoryDir(opts.home, opts.projectDir);
  fs.mkdirSync(dir, { recursive: true });
  if (fs.readdirSync(dir).length > 0) return { dir, copied: [] };

  const ids = new Set(opts.overseerSessionIds.filter(Boolean));
  const shared = sharedProjectMemoryDir(opts.home, opts.projectDir);
  let names: string[] = [];
  try { names = fs.readdirSync(shared); } catch { /* no shared folder yet */ }

  const copied: string[] = [];
  for (const name of names.sort()) {
    if (name === INDEX || !name.endsWith('.md') || !isPlainFile(shared, name)) continue;
    let text: string;
    try { text = fs.readFileSync(path.join(shared, name), 'utf8'); } catch { continue; }
    const origin = noteOriginSessionId(text);
    if (!origin || !ids.has(origin)) continue;
    fs.writeFileSync(path.join(dir, name), text, { flag: 'wx' });
    copied.push(name);
  }

  if (copied.length && isPlainFile(shared, INDEX)) {
    const index = fs.readFileSync(path.join(shared, INDEX), 'utf8');
    const linked = index.split(/\r?\n/).filter((line) => copied.some((n) => line.includes(`(${n})`) || line.includes(`(./${n})`)));
    if (linked.length) fs.writeFileSync(path.join(dir, INDEX), `${linked.join('\n')}\n`, { flag: 'wx' });
  }

  fs.writeFileSync(path.join(dir, COPY_MARKER), `${JSON.stringify({ copied })}\n`, { flag: 'wx' });
  return { dir, copied };
}
