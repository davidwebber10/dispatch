import fs from 'node:fs';
import path from 'node:path';
import { insideRealRoot } from '../files/confine.js';
import { holdsSecret, type SecretRoots } from '../files/secret-paths.js';
import { PROJECT_FILE_MIME } from './files.js';

/**
 * Snapshots of plugin files (Drops, 2026-11-11). A file a thread posts is copied into the data folder
 * at post time, `<dataDir>/plugin-files/<plugin>/<fileId><ext>`, and the daemon serves the copy:
 *
 * - The copy never changes, so a browser may keep it (and its thumbnails) for a year: on an iPhone the
 *   second look at a picture costs no download at all.
 * - The preview shows what the thread posted, also after the project file changed, moved or went.
 *
 * The copy is made only after the checks of the post (checkProjectFile) and the credential check, on the
 * OPEN file, so the bytes that are copied are the bytes that were checked. A file over the limit, or a copy
 * that fails, gets no snapshot: the project file is served as before, with its checks.
 */
export const SNAPSHOT_MAX_BYTES = 25 * 1024 * 1024;

/** A snapshot's file name: the file id and a known extension. Nothing else in the folder is ever served. */
const NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z]{2,8}$/;

/** A plugin id as a folder name (ids are already checked; this keeps any other text out of the path). */
const safeId = (pluginId: string): string => pluginId.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '_');

export function snapshotDir(dataDir: string, pluginId: string): string {
  return path.join(dataDir, 'plugin-files', safeId(pluginId));
}

/** The path of a snapshot, or null when the name is not one this module writes. */
export function snapshotPath(dataDir: string, pluginId: string, name: string | null): string | null {
  if (!name || !NAME.test(name)) return null;
  return path.join(snapshotDir(dataDir, pluginId), name);
}

/**
 * Copy `src` (a file of the project at `root`) for the file reference `fileId`. Answers the snapshot's
 * name, or null when no copy was made (too large, a credential, not a regular file, any error).
 */
export async function takeSnapshot(opts: {
  dataDir: string; pluginId: string; fileId: string; src: string; root: string; roots: SecretRoots; maxBytes?: number;
}): Promise<string | null> {
  const max = opts.maxBytes ?? SNAPSHOT_MAX_BYTES;
  const ext = path.extname(opts.src).toLowerCase();
  if (!PROJECT_FILE_MIME[ext]) return null;
  const name = `${opts.fileId}${ext}`;
  const out = snapshotPath(opts.dataDir, opts.pluginId, name);
  if (!out) return null;
  let real: string;
  try { real = await fs.promises.realpath(opts.src); } catch { return null; }
  if (!insideRealRoot(opts.root, real)) return null;
  let fh: fs.promises.FileHandle | null = null;
  const tmp = `${out}.${process.pid}.tmp`;
  try {
    fh = await fs.promises.open(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const st = await fh.stat();
    if (!st.isFile() || st.size > max) return null;
    if (await holdsSecret(real, opts.roots, fh).catch(() => true)) return null;
    const bytes = await fh.readFile();
    if (bytes.length > max) return null; // it grew after the stat
    const dir = path.dirname(out);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    await fs.promises.writeFile(tmp, bytes, { mode: 0o600, flag: 'wx' });
    await fs.promises.rename(tmp, out);
    return name;
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch { /* nothing written */ }
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/** Remove one snapshot (the file reference is gone). Best effort. */
export function removeSnapshot(dataDir: string, pluginId: string, name: string | null): void {
  const p = snapshotPath(dataDir, pluginId, name);
  if (p) { try { fs.rmSync(p, { force: true }); } catch { /* already gone */ } }
}

/** Remove every snapshot of a plugin (its data is cleared). Best effort. */
export function removeAllSnapshots(dataDir: string, pluginId: string): void {
  try { fs.rmSync(snapshotDir(dataDir, pluginId), { recursive: true, force: true }); } catch { /* already gone */ }
}
