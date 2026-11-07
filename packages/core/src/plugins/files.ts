import fs from 'node:fs';
import path from 'node:path';
import { insideRealRoot } from '../files/confine.js';

/**
 * A file of a project that a plugin references (docs/superpowers/specs/2026-11-07-plugins-design.md,
 * section 5; the checks come from the previews design, 2026-10-28): the path must be inside the
 * project folder after symlinks are resolved, carry a known extension, and be a regular file of
 * a bounded size. The same check runs when the file is served.
 */
export const PROJECT_FILE_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.html': 'text/html', '.htm': 'text/html',
  '.md': 'text/markdown', '.markdown': 'text/markdown', '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json',
};
export const PROJECT_FILE_MAX_BYTES = 50 * 1024 * 1024;

export interface ProjectFile { path: string; name: string; mime: string; size: number }

export class ProjectFileError extends Error {
  constructor(message: string, readonly status: number = 400) { super(message); }
}

function resolveSafe(root: string, requested: string): string | null {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, requested);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return resolved;
}

/** Check and describe one requested file. Throws ProjectFileError with the reason the caller should read. */
export function checkProjectFile(workingDir: string, requested: unknown): ProjectFile {
  if (typeof requested !== 'string' || !requested.trim()) throw new ProjectFileError('each path must be a non-empty string');
  const abs = resolveSafe(workingDir, requested.trim());
  if (!abs || !insideRealRoot(workingDir, abs)) throw new ProjectFileError(`path is outside the project folder: ${requested}`);
  const mime = PROJECT_FILE_MIME[path.extname(abs).toLowerCase()];
  if (!mime) throw new ProjectFileError(`unsupported file type: ${path.basename(abs)} (png, jpg, gif, webp, svg, pdf, html, md, txt, csv, json)`);
  let st: fs.Stats;
  try { st = fs.statSync(abs); } catch { throw new ProjectFileError(`file not found: ${requested}`, 404); }
  if (!st.isFile()) throw new ProjectFileError(`not a file: ${requested}`);
  if (st.size > PROJECT_FILE_MAX_BYTES) throw new ProjectFileError(`file too large (max 50 MB): ${requested}`);
  return { path: abs, name: path.basename(abs), mime, size: st.size };
}
