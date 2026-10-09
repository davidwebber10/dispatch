/**
 * The source file of a ledger item (titles and source panel spec 2026-10-09, Unit 7), for the
 * section panel on the Control Plane.
 *
 * - Plan and doc sources name the file in `source_ref`; an agent-block source keeps "path#section"
 *   in `source_section` (split on the first "#"). Paths are relative to the project folder.
 * - The real path (symlinks resolved) must stay inside the project folder; worktrees under the
 *   project folder count as inside. An absolute path is accepted only when it is inside the
 *   project folder.
 * - A missing file whose path starts with `.claude/worktrees/<name>/` is tried once more as the
 *   rest of the path in the project folder: the worktree is gone, the main checkout has the file
 *   (`fromMainCheckout`).
 * - Markdown files only (`.md`, `.markdown`). Another file, a folder, or a file larger than 5 MB
 *   gives the path only, with the reason.
 *
 * The file is read as it is now, not as it was when the item was recorded (a known limit).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LedgerItem } from '../db/ledger.js';

export const SOURCE_MAX_BYTES = 5 * 1024 * 1024;

export const NOT_MARKDOWN_REASON = 'This file is not markdown, so the panel cannot show a section of it.';
export const FOLDER_REASON = 'This source is a folder, not a file.';
export const TOO_LARGE_REASON = 'This file is larger than 5 MB, so the panel does not show it.';

export type SourceFile =
  | { kind: 'file'; path: string; file: string; fromMainCheckout: boolean; markdown: string }
  | { kind: 'file-only'; path: string; file: string; fromMainCheckout: boolean; reason: string }
  /** Not in the project folder, nor (for a worktree path) in the main checkout. */
  | { kind: 'gone' }
  /** The path, or a symlink on it, leads out of the project folder. */
  | { kind: 'outside' };

const clean = (s: string | null) => s?.trim() || null;

/** The file and the section an item's source names; null for a source without a file. */
export function sourceFileRef(
  item: Pick<LedgerItem, 'sourceKind' | 'sourceRef' | 'sourceSection' | 'agentTerminalId'>,
): { path: string; section: string | null } | null {
  switch (item.sourceKind) {
    case 'plan':
    case 'doc': {
      const file = clean(item.sourceRef);
      return file ? { path: file, section: clean(item.sourceSection) } : null;
    }
    case 'agent': {
      // Only an agent-block item stores a file ("path#section"); a plain agent source names a part of the report.
      if (!item.agentTerminalId || !item.sourceSection) return null;
      const hash = item.sourceSection.indexOf('#');
      const file = clean(hash === -1 ? item.sourceSection : item.sourceSection.slice(0, hash));
      return file ? { path: file, section: hash === -1 ? null : clean(item.sourceSection.slice(hash + 1)) } : null;
    }
    default:
      return null;
  }
}

const leadsOut = (rel: string) => !rel || rel === '.' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
const WORKTREE = /^\.claude\/worktrees\/[^/]+\/(.+)$/;

/** `ref` as a path relative to the project folder; null when it leads out of the folder before any symlink. */
function projectRelative(projectDir: string, realRoot: string, ref: string): string | null {
  if (path.isAbsolute(ref)) {
    // Inside the folder as given, or inside its real path (/tmp/x and /private/tmp/x on macOS).
    for (const root of [path.resolve(projectDir), realRoot]) {
      const rel = path.relative(root, path.resolve(ref));
      if (!leadsOut(rel)) return rel;
    }
    return null;
  }
  const rel = path.normalize(ref);
  return leadsOut(rel) ? null : rel;
}

/** The real path of `rel` under the project: 'missing' when it does not resolve, 'outside' when a symlink leads out. */
function locate(realRoot: string, rel: string): string | 'missing' | 'outside' {
  let real: string;
  try {
    real = fs.realpathSync(path.join(realRoot, rel));
  } catch {
    return 'missing'; // absent, a dangling symlink, a loop or an unreadable folder
  }
  return leadsOut(path.relative(realRoot, real)) ? 'outside' : real;
}

function open(real: string, rel: string, fromMainCheckout: boolean): SourceFile {
  const where = { path: rel.split(path.sep).join('/'), file: path.basename(rel), fromMainCheckout };
  let st: fs.Stats;
  try { st = fs.statSync(real); } catch { return { kind: 'gone' }; }
  if (st.isDirectory()) return { kind: 'file-only', ...where, reason: FOLDER_REASON };
  // Never read a pipe or a device: only a regular markdown file.
  if (!st.isFile() || !/\.(md|markdown)$/i.test(rel)) return { kind: 'file-only', ...where, reason: NOT_MARKDOWN_REASON };
  if (st.size > SOURCE_MAX_BYTES) return { kind: 'file-only', ...where, reason: TOO_LARGE_REASON };
  try {
    return { kind: 'file', ...where, markdown: fs.readFileSync(real, 'utf8') };
  } catch {
    return { kind: 'gone' };
  }
}

/** The file `ref` names, read under the project folder `projectDir` only. */
export function readSourceFile(projectDir: string, ref: string): SourceFile {
  let realRoot: string;
  try { realRoot = fs.realpathSync(projectDir); } catch { return { kind: 'gone' }; }
  const rel = projectRelative(projectDir, realRoot, ref);
  if (rel === null) return { kind: 'outside' };
  const found = locate(realRoot, rel);
  if (found === 'outside') return { kind: 'outside' };
  if (found !== 'missing') return open(found, rel, false);
  // The worktree is gone: the rest of the path, in the main checkout.
  const rest = rel.split(path.sep).join('/').match(WORKTREE)?.[1];
  if (rest) {
    const mainRel = path.normalize(rest);
    if (!leadsOut(mainRel)) {
      const main = locate(realRoot, mainRel);
      if (main === 'outside') return { kind: 'outside' };
      if (main !== 'missing') return open(main, mainRel, true);
    }
  }
  return { kind: 'gone' };
}
