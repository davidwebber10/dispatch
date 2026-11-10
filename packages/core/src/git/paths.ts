/**
 * Path checks for the diff review (engineering program W3-G).
 *
 * Approve and Discard act on files the page names. Three checks stand between a name and a file:
 *   1. the text (`checkRelPath`): relative, no `..`, no `.git`, no NUL, written the way git writes it;
 *   2. the real location (`confine`): every folder on the way is a real folder inside the real working
 *      directory. A symbolic link among the folders is refused, even one that stays inside: git never lists a
 *      file through a link, so such a path is not one the page showed;
 *   3. the credential list (`isSecretPath`, W1-B).
 * The caller adds a fourth: the path must be one of the changed files git lists right now.
 */
import fs from 'node:fs';
import path from 'node:path';
import { within } from '../files/confine.js';
import { isSecretPath, SECRET_PATH_ERROR, type SecretRoots } from '../files/secret-paths.js';

/** A path the review refuses. `status` is the HTTP answer. */
export class PathRefused extends Error {
  constructor(message: string, readonly status: 400 | 403 = 403) { super(message); this.name = 'PathRefused'; }
}

/** The text check. Returns the path; throws `PathRefused`. */
export function checkRelPath(rel: unknown): string {
  if (typeof rel !== 'string' || rel === '') throw new PathRefused('A path must be a non-empty string.');
  if (rel.includes('\0')) throw new PathRefused('Path traversal not allowed');
  if (path.isAbsolute(rel) || /^[A-Za-z]:[\\/]/.test(rel) || rel.startsWith('\\')) throw new PathRefused('Path traversal not allowed: the path must be relative to the working directory.');
  const parts = rel.split('/');
  // Git writes a file path with no empty part, no "." and no "..": anything else is not a listed file.
  if (parts.some((p) => p === '' || p === '.' || p === '..')) throw new PathRefused('Path traversal not allowed');
  if (parts.some((p) => p.toLowerCase() === '.git')) throw new PathRefused('A path inside .git is not a project file.');
  return rel;
}

/**
 * The real-location check. Returns the absolute path of `rel` under the REAL working directory.
 * The last part may be a symbolic link (the review acts on the link itself, never on its target) and may be
 * missing (a deleted file). Every folder before it that exists must be a real folder at its written place.
 */
export async function confine(workDir: string, rel: string, roots?: SecretRoots): Promise<string> {
  checkRelPath(rel);
  let root: string;
  try { root = await fs.promises.realpath(path.resolve(workDir)); } catch { throw new PathRefused('The working directory does not exist.', 400); }
  const abs = path.join(root, ...rel.split('/'));
  if (!within(root, abs) || abs === root) throw new PathRefused('Path traversal not allowed');
  // The nearest folder on the way that exists. `lstat` so a link is seen as a link, not followed.
  let probe = path.dirname(abs);
  for (;;) {
    try { await fs.promises.lstat(probe); break; } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw new PathRefused('Path traversal not allowed');
    }
    const parent = path.dirname(probe);
    if (parent === probe || !within(root, parent)) throw new PathRefused('Path traversal not allowed');
    probe = parent;
  }
  let real: string;
  try { real = await fs.promises.realpath(probe); } catch { throw new PathRefused('Path traversal not allowed'); }
  if (real !== probe) throw new PathRefused(`Path traversal not allowed: "${rel}" goes through a symbolic link.`);
  if (roots) {
    let realLeaf: string | null = null;
    try { realLeaf = await fs.promises.realpath(abs); } catch { /* missing, or a dangling link */ }
    if (isSecretPath(abs, roots) || (realLeaf !== null && isSecretPath(realLeaf, roots))) throw new PathRefused(SECRET_PATH_ERROR);
  }
  return abs;
}

/** The real path of a directory, or its resolved text when it is gone. For comparing two directories. */
export function realDir(dir: string): string {
  try { return fs.realpathSync(path.resolve(dir)); } catch { return path.resolve(dir); }
}
