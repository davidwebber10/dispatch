import fs from 'node:fs';
import path from 'node:path';

/**
 * Make the data directory private to the user (network exposure spec 7.14; overview SEC-18).
 *
 * A 0700 directory keeps other accounts out of everything inside it, whatever the modes of
 * the files are. Files that hold the most are tightened as well, because SQLite copies the
 * database file's mode onto its -wal and -shm files. The process umask is NOT changed: it
 * would be inherited by every terminal and agent the daemon spawns.
 */
const SECRET_FILES = ['dispatch.db', 'dispatch.db-wal', 'dispatch.db-shm', 'access-token', 'access.json'];

/** Windows mounts under WSL cannot hold unix modes, so a chmod there is meaningless. */
const noUnixModes = (p: string) => /^\/mnt\/[a-z](\/|$)/i.test(p);

export function lockDownDataDir(
  dataDir: string,
  extraDirs: string[] = [],
  warn: (msg: string) => void = (m) => console.warn(m),
): void {
  const tighten = (p: string, mode: number) => {
    try { fs.chmodSync(p, mode); } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      if (!noUnixModes(p)) warn(`Could not set mode ${mode.toString(8)} on ${p}: ${(err as Error).message}`);
    }
  };
  const ensureDir = (d: string) => {
    try { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); } catch (err) {
      if (!noUnixModes(d)) warn(`Could not create ${d}: ${(err as Error).message}`);
      return;
    }
    tighten(d, 0o700);
  };

  ensureDir(dataDir);
  // Create the database empty and private, so a first run never has a world-readable moment.
  const db = path.join(dataDir, 'dispatch.db');
  try { fs.closeSync(fs.openSync(db, 'a', 0o600)); } catch { /* the chmod below reports it */ }
  for (const f of SECRET_FILES) tighten(path.join(dataDir, f), 0o600);

  for (const d of extraDirs) {
    ensureDir(d);
    let names: string[] = [];
    try { names = fs.readdirSync(d); } catch { /* none */ }
    for (const n of names) if (n.endsWith('.log')) tighten(path.join(d, n), 0o600);
  }
}
