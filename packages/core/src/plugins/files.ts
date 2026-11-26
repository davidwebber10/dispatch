import fs from 'node:fs';
import path from 'node:path';
import type { Response } from 'express';
import { insideRealRoot } from '../files/confine.js';
import { openInside } from '../files/confinedOpen.js';
import { holdsSecret, isSecretPath, SECRET_PATH_ERROR, type SecretRoots } from '../files/secret-paths.js';
import { PATH_REFUSALS, type PathPolicy } from '../files/path-policy.js';
import { privsep, type PrivsepConfig } from '../privsep/config.js';
import { agentReadFile } from '../privsep/agent-fs.js';

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


/** Check and describe one requested file. Throws ProjectFileError with the reason the caller should read. */
export function checkProjectFile(workingDir: string, requested: unknown): ProjectFile {
  if (typeof requested !== 'string' || !requested.trim()) throw new ProjectFileError('each path must be a non-empty string');
  // The real-root check decides (symlinks resolved on both sides): a path in the project folder's
  // real form (/private/var for /var on macOS) is inside it; a textual comparison would refuse it.
  const abs = path.resolve(workingDir, requested.trim());
  if (!insideRealRoot(workingDir, abs)) throw new ProjectFileError(`path is outside the project folder: ${requested}`);
  const mime = PROJECT_FILE_MIME[path.extname(abs).toLowerCase()];
  if (!mime) throw new ProjectFileError(`unsupported file type: ${path.basename(abs)} (png, jpg, gif, webp, svg, pdf, html, md, txt, csv, json)`);
  let st: fs.Stats;
  try { st = fs.statSync(abs); } catch { throw new ProjectFileError(`file not found: ${requested}`, 404); }
  if (!st.isFile()) throw new ProjectFileError(`not a file: ${requested}`);
  if (st.size > PROJECT_FILE_MAX_BYTES) throw new ProjectFileError(`file too large (max 50 MB): ${requested}`);
  return { path: abs, name: path.basename(abs), mime, size: st.size };
}

/** The largest code file the Inbox `preview` tool reads as a snippet (kind=code, one path): its `text` cap. */
export const CODE_FILE_MAX_BYTES = 64 * 1024;
export const HIDDEN_CODE_FILE = 'This file is hidden (its name or a folder on the way starts with "."). Pass the snippet in `text` instead.';

/**
 * The text of ONE file of the project, for the Inbox `preview` tool's kind=code (a thread names a source
 * file instead of pasting it). The same checks as every route that serves a project file, and more:
 *   - inside the project after links are resolved, and allowed by the path policy (files/path-policy.ts);
 *   - not a credential, by path or by identity (files/secret-paths.ts);
 *   - no hidden file or folder on the way (`.env`, `.git/config`, `.claude/…`), on every install;
 *   - opened ONCE (openInside: O_NOFOLLOW, O_NONBLOCK, the folders pinned); every later check is on the
 *     open descriptor: a regular file, ONE name on the disk (a hard link can name an outside file), at most
 *     CODE_FILE_MAX_BYTES, read from the descriptor with that cap; no NUL byte (not text).
 * Throws ProjectFileError with the status and the sentence the caller passes on.
 */
export async function readProjectCodeFile(workingDir: string, requested: unknown, opts: { policy: PathPolicy; secretRoots: SecretRoots }): Promise<{ name: string; text: string }> {
  if (typeof requested !== 'string' || !requested.trim()) throw new ProjectFileError('path must be a non-empty string');
  const abs = path.resolve(workingDir, requested.trim());
  if (!insideRealRoot(workingDir, abs)) throw new ProjectFileError(`path is outside the project folder: ${requested}`, 403);
  let real: string;
  try { real = fs.realpathSync(abs); } catch { throw new ProjectFileError(`file not found: ${requested}`, 404); }
  // The path as written (against the project folder as written, or its real form) and the real path.
  const wd = path.resolve(workingDir);
  const realWd = fs.realpathSync(workingDir);
  const rels = [path.relative(realWd, real)];
  for (const root of [wd, realWd]) if (abs === root || abs.startsWith(root + path.sep)) rels.push(path.relative(root, abs));
  if (rels.some((r) => r.split(path.sep).some((seg) => seg.startsWith('.')))) throw new ProjectFileError(HIDDEN_CODE_FILE, 403);
  const why = opts.policy.problem(abs, { project: workingDir, use: 'read' });
  if (why) throw new ProjectFileError(PATH_REFUSALS[why], 403);
  if (isSecretPath(abs, opts.secretRoots) || isSecretPath(real, opts.secretRoots)) throw new ProjectFileError(SECRET_PATH_ERROR, 403);
  const o = await openInside(workingDir, abs);
  if (o.kind === 'outside') throw new ProjectFileError(`path is outside the project folder: ${requested}`, 403);
  if (o.kind === 'missing') throw new ProjectFileError(`file not found: ${requested}`, 404);
  try {
    const st = await o.fh.stat();
    if (!st.isFile()) throw new ProjectFileError(`not a file: ${requested}`);
    // More than one name: refused on every install here (the path policy refuses it on a hosted box only).
    if (st.nlink > 1) throw new ProjectFileError(PATH_REFUSALS.hardlink, 403);
    const opened = opts.policy.openedProblem(st, real);
    if (opened) throw new ProjectFileError(PATH_REFUSALS[opened], 403);
    if (await holdsSecret(real, opts.secretRoots, o.fh).catch(() => true)) throw new ProjectFileError(SECRET_PATH_ERROR, 403);
    if (st.size > CODE_FILE_MAX_BYTES) throw new ProjectFileError('file too long (max 64 KB); pass the part that matters in `text`', 413);
    // Read from the descriptor, at most the cap plus one byte: a file that grows meanwhile stays bounded.
    const buf = Buffer.alloc(CODE_FILE_MAX_BYTES + 1);
    let n = 0;
    for (;;) {
      const { bytesRead } = await o.fh.read(buf, n, buf.length - n, null);
      if (bytesRead === 0) break;
      n += bytesRead;
      if (n >= buf.length) break;
    }
    if (n > CODE_FILE_MAX_BYTES) throw new ProjectFileError('file too long (max 64 KB); pass the part that matters in `text`', 413);
    const bytes = buf.subarray(0, n);
    if (bytes.includes(0)) throw new ProjectFileError(`not a text file: ${requested}`, 415);
    return { name: path.basename(abs), text: bytes.toString('utf8') };
  } finally {
    await o.fh.close().catch(() => { /* best effort */ });
  }
}

/**
 * Send the bytes of a project file whose path the caller has checked (no snapshot of it exists). The
 * caller has set the headers. On a box with privilege separation the daemon is root and the project
 * is the agent's, so the file is read AS THE AGENT (privsep/agent-fs.ts) and not with the daemon's
 * rights: a folder swapped for a link after the checks cannot make the daemon send a file of its own.
 * Elsewhere it is `res.sendFile`, as before.
 */
export async function sendProjectFile(res: Response, filePath: string, cfg: PrivsepConfig | null = privsep()): Promise<void> {
  const missing = () => { if (!res.headersSent) res.status(404).json({ error: 'file not found' }); };
  if (!cfg) {
    res.sendFile(filePath, (err) => { if (err) missing(); });
    return;
  }
  const bytes = await agentReadFile(filePath, PROJECT_FILE_MAX_BYTES, cfg);
  if (!bytes) return missing();
  res.end(bytes);
}
