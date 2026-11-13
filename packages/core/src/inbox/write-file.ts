import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { within } from '../files/confine.js';
import { holdsSecret, isSecretPath, type SecretRoots } from '../files/secret-paths.js';
import { upsertDotenv } from './secret-store.js';
import { privsep } from '../privsep/config.js';
import { agentMkdir, agentReadFile, agentRemove, agentRename, agentWriteFile } from '../privsep/agent-fs.js';

/**
 * The file destination of an inbox secret (2026-11-12): the daemon writes the value into a file of the thread's
 * project, so the value never travels to the thread. Stricter than the read routes: no DISPATCH_FILE_ROOTS, no
 * node_modules exception, no symbolic link at the end or on the way out, no `.git` folder, no credential place.
 */
export class SecretFileError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 413 = 403) { super(message); }
}

/** An existing file is read for the upsert up to this size. */
const EDIT_MAX_BYTES = 1024 * 1024;

export interface WrittenFile {
  /** The path relative to the project folder, with `/`. */
  rel: string;
  /** True: git ignores it. False: a git repository that does not. Null: no repository (or no git). */
  gitIgnored: boolean | null;
}

/** The nearest part of `p` that exists, and the parts after it. */
function nearestExisting(p: string): { base: string; rest: string[] } {
  let probe = p;
  const rest: string[] = [];
  for (;;) {
    try { fs.lstatSync(probe); return { base: probe, rest }; } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw new SecretFileError(`cannot use this path (${code ?? 'error'})`);
    }
    const parent = path.dirname(probe);
    if (parent === probe) throw new SecretFileError('cannot use this path');
    rest.unshift(path.basename(probe));
    probe = parent;
  }
}

/** The real form of `target` (every link on the way resolved), checked to be a file place inside `realRoot`. */
function confine(realRoot: string, target: string): string {
  const { base, rest } = nearestExisting(target);
  let real: string;
  try { real = fs.realpathSync(base); } catch { throw new SecretFileError('the path goes through a broken link'); }
  const full = path.join(real, ...rest);
  if (full === realRoot || !within(realRoot, full)) throw new SecretFileError('the path is outside the project folder');
  return full;
}

function gitIgnored(dir: string, name: string): Promise<boolean | null> {
  return new Promise((resolve) => {
    execFile('git', ['check-ignore', '-q', '--', name], { cwd: dir, timeout: 5000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }, (err) => {
      if (!err) return resolve(true);
      const code = (err as { code?: unknown }).code;
      resolve(code === 1 ? false : null);
    });
  });
}

/**
 * Write `value` into the project file `requested` (relative to `root`, or absolute inside it). With `name`, one
 * `NAME=value` line is upserted in the file (dotenv); without, the value is the whole file. The file ends 0600.
 * Throws SecretFileError with a message that names the path, never the value.
 */
export async function writeSecretFile(opts: { root: string; requested: string; name?: string; value: string; roots: SecretRoots }): Promise<WrittenFile> {
  const { root, requested, name, value, roots } = opts;
  let realRoot: string;
  try { realRoot = fs.realpathSync(path.resolve(root)); } catch { throw new SecretFileError('the project folder is gone', 404); }
  const target = path.resolve(realRoot, requested);
  // The path as written must be in the project too (a `..` that a link would bring back is still refused).
  if (!within(path.resolve(root), target) && !within(realRoot, target)) throw new SecretFileError('the path is outside the project folder');
  const full = confine(realRoot, target);
  const rel = path.relative(realRoot, full).split(path.sep).join('/');
  if (rel.split('/').some((part) => part.toLowerCase() === '.git')) throw new SecretFileError('a secret is never written into the .git folder');
  if (isSecretPath(full, roots) || isSecretPath(target, roots)) throw new SecretFileError('this path holds credentials: Dispatch does not write there');

  // An existing entry must be a plain file: not a link (a write would land at its target), not a folder.
  let existing: fs.Stats | null = null;
  try { existing = fs.lstatSync(full); } catch { existing = null; }
  if (existing?.isSymbolicLink()) throw new SecretFileError('the path is a symbolic link: name the real file');
  if (existing && !existing.isFile()) throw new SecretFileError('the path is not a regular file', 400);
  if (existing && await holdsSecret(full, roots).catch(() => true)) throw new SecretFileError('this path holds credentials: Dispatch does not write there');

  // With privilege separation the daemon is root and the project is the agent's: every read and change below
  // goes through the agent user (privsep/agent-fs.ts), so a folder swapped for a link meanwhile leads only where
  // the agent could already go. The checks above are the same; they no longer have to win the race alone.
  const cfg = privsep();

  let content = value;
  if (name !== undefined) {
    let before = '';
    if (existing) {
      if (existing.size > EDIT_MAX_BYTES) throw new SecretFileError('the file is too large to edit (max 1 MB)', 413);
      if (cfg) {
        const bytes = await agentReadFile(full, EDIT_MAX_BYTES, cfg);
        if (bytes === null) throw new SecretFileError('cannot read the file to edit it', 400);
        before = bytes.toString('utf8');
      } else {
        const fd = fs.openSync(full, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
        try { before = fs.readFileSync(fd, 'utf8'); } finally { fs.closeSync(fd); }
      }
    }
    content = upsertDotenv(before, name, value); // a DotenvError names no value
  }

  if (cfg) {
    const dir = path.dirname(full);
    const tmp = path.join(dir, `.${path.basename(full)}.inbox-${randomBytes(6).toString('hex')}.tmp`);
    try {
      agentMkdir(dir, cfg);
      agentWriteFile(tmp, content, { flag: 'wx', mode: 0o600 }, cfg);
    } catch (e) {
      try { agentRemove(tmp, {}, cfg); } catch { /* not made */ }
      throw new SecretFileError(`could not write the file (${(e as NodeJS.ErrnoException).code ?? 'error'})`, 400);
    }
    try { agentRename(tmp, full, cfg); } catch (e) {
      try { agentRemove(tmp, {}, cfg); } catch { /* gone */ }
      throw new SecretFileError(`could not write the file (${(e as NodeJS.ErrnoException).code ?? 'error'})`, 400);
    }
    return { rel, gitIgnored: await gitIgnored(dir, path.basename(full)) };
  }

  // The folders on the way, made inside the project only, then checked again (a link swapped in meanwhile).
  const dir = path.dirname(full);
  fs.mkdirSync(dir, { recursive: true });
  let realDir: string;
  try { realDir = fs.realpathSync(dir); } catch { throw new SecretFileError('cannot make the folder'); }
  if (realDir !== dir || !within(realRoot, realDir)) throw new SecretFileError('the path is outside the project folder');

  // A new file beside the target, then a rename over it: a rename replaces a link put there meanwhile, it never
  // follows one, and a reader never sees half a file.
  const tmp = path.join(dir, `.${path.basename(full)}.inbox-${randomBytes(6).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } catch (e) {
    fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    throw new SecretFileError(`could not write the file (${(e as NodeJS.ErrnoException).code ?? 'error'})`, 400);
  }
  fs.closeSync(fd);
  try { fs.renameSync(tmp, full); } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw new SecretFileError(`could not write the file (${(e as NodeJS.ErrnoException).code ?? 'error'})`, 400);
  }
  return { rel, gitIgnored: await gitIgnored(dir, path.basename(full)) };
}
