import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import * as store from '../db/memory.js';
import { projectScope, MAX_NOTE_CHARS } from '../db/memory.js';
import { claudeMemoryProjectDir, sharedProjectMemoryDir } from '../overseer/memory-scope.js';
import type { MemoryService } from './service.js';

/**
 * Claude Code's own memory, imported as notes (spec 2026-11-17-memory-design.md, section 4.8, decision 1:
 * keep it, and import it). Each project's `~/.claude/projects/<repo>/memory/*.md` file becomes one note
 * of the project's scope (origin 'import'), so a Codex thread of the project finds what the Claude
 * threads wrote there. It runs at every start; a file is saved once for each version of its text
 * (`source_ref` = file name + hash), and when a file changes, the note of its old text is deleted.
 * Claude Code keeps its own memory as it is: nothing here writes to its folder.
 */

const PREFIX = 'claude-memory:';
const MAX_FILE_BYTES = 256 * 1024;
const MAX_FILES = 500;

/** The text of a memory file as one note: its description, then its body, without the frontmatter. */
export function noteTextOf(raw: string, file: string): string {
  let body = raw.replace(/\r\n?/g, '\n');
  let description = '';
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(body);
  if (fm) {
    description = /^description:\s*(.+)$/m.exec(fm[1])?.[1]?.trim().replace(/^["']|["']$/g, '') ?? '';
    body = body.slice(fm[0].length);
  }
  let text = [description, body.trim()].filter(Boolean).join('\n\n');
  if (text.length > MAX_NOTE_CHARS) {
    const tail = `\n… (cut; the whole file: ${file})`;
    text = text.slice(0, MAX_NOTE_CHARS - tail.length) + tail;
  }
  return text;
}

export interface ImportDeps {
  db: Database.Database;
  home: string;
  memory: MemoryService;
  /** Test seam: Claude's folder key for a working directory (default: git's main root). */
  projectDir?: (workDir: string) => string | null;
}

/** Import every project's Claude Code memory. Returns the number of notes saved. */
export function importClaudeMemory(deps: ImportDeps): number {
  const { db, memory } = deps;
  if (!memory.active()) return 0;
  const projectDir = deps.projectDir ?? ((w: string) => claudeMemoryProjectDir(w).dir);
  const projects = db.prepare('SELECT id, working_dir FROM sessions WHERE archived_at IS NULL').all() as { id: string; working_dir: string }[];
  let saved = 0;
  for (const p of projects) {
    if (!memory.readableScopes(p.id).includes(projectScope(p.id))) continue; // the project is not remembered
    let dir: string | null = null;
    try { dir = projectDir(p.working_dir); } catch { /* git failed: try again at the next start */ }
    if (!dir) continue;
    saved += importFolder(db, projectScope(p.id), sharedProjectMemoryDir(deps.home, dir));
  }
  return saved;
}

function importFolder(db: Database.Database, scope: string, folder: string): number {
  let names: string[];
  try { names = fs.readdirSync(folder).filter((n) => n.endsWith('.md')).sort().slice(0, MAX_FILES); } catch { return 0; }
  let saved = 0;
  for (const name of names) {
    const file = path.join(folder, name);
    let raw: string;
    let mtime: Date;
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) continue; // a link or a huge file is not a memory note
      raw = fs.readFileSync(file, 'utf8');
      mtime = st.mtime;
    } catch { continue; }
    const text = noteTextOf(raw, file);
    if (!text) continue;
    const ref = `${PREFIX}${name}:${createHash('sha256').update(raw).digest('hex').slice(0, 16)}`;
    const before = (db.prepare('SELECT 1 FROM memory_notes WHERE scope = ? AND source_ref = ?').get(scope, ref)) !== undefined;
    if (before) continue;
    db.transaction(() => {
      // The note of the file's older text goes: the file is the truth, and it changed.
      const old = db.prepare("SELECT id FROM memory_notes WHERE scope = ? AND source_ref LIKE ? ESCAPE '\\' AND status != 'deleted'")
        .all(scope, `${PREFIX}${name.replace(/[\\%_]/g, (c) => `\\${c}`)}:%`) as { id: number }[];
      for (const o of old) store.deleteNote(db, o.id);
      store.addNote(db, { scope, text, origin: 'import', sourceRef: ref, createdAt: mtime.toISOString() });
    })();
    saved++;
  }
  return saved;
}
