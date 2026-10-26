import fs from 'fs';
import path from 'path';

const THREAD_FILE = /^thread-([A-Za-z0-9_-]+)\.mcp\.json$/;
/** A file this young may belong to a spawn that has written it but not yet started its CLI. */
const MIN_AGE_MS = 60_000;

/**
 * Delete per-thread MCP config files (`thread-<id>.mcp.json`) that no live thread needs. Archive and
 * delete already remove their own file; this catches the ones left behind by daemon restarts, crashes
 * and older versions. Every spawn rewrites its file before its CLI starts, so a file for a thread that
 * is not running is safe to remove. Kept: a thread that is alive, and any file younger than a minute.
 * Returns how many files it removed. Never throws.
 */
export function sweepThreadMcpConfigs(
  dir: string,
  isAlive: (terminalId: string) => boolean,
  now: number = Date.now(),
): number {
  let removed = 0;
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return 0; }
  for (const name of names) {
    const m = THREAD_FILE.exec(name);
    if (!m) continue;
    const id = m[1];
    try {
      if (isAlive(id)) continue;
      const file = path.join(dir, name);
      const st = fs.lstatSync(file);
      if (!st.isFile() || now - st.mtimeMs < MIN_AGE_MS) continue;
      fs.unlinkSync(file);
      removed++;
    } catch { /* leave it; the next start tries again */ }
  }
  return removed;
}

/** `keys/ID.H`: a per-handle key file (ThreadKeys.writeKeyFile). The terminal id is a plain name. */
const KEY_FILE = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;

/**
 * Delete the key-related files that a thread left behind: named files only, never a folder, never a
 * recursive delete. The files: the Grok MCP file and hooks file of a thread's plugin, the OpenCode
 * config, and the per-handle key files. A thread that is alive, and any file younger than a minute,
 * stay. Returns how many files it removed. Never throws.
 *
 * A Grok home links everything except `plugins` back to the real Grok home, and `lstat` checks only the
 * last part of a path. So before each unlink: the file itself must be a plain file (not a symlink), and
 * the real path of its folder must equal the expected folder under the real data folder. Any mismatch
 * skips the file.
 */
export function sweepThreadKeyFiles(
  dataDir: string,
  isAlive: (terminalId: string) => boolean,
  now: number = Date.now(),
): number {
  let root: string;
  try { root = fs.realpathSync(dataDir); } catch { return 0; }
  let removed = 0;

  const removeIfSafe = (folderRel: string[], name: string): void => {
    try {
      const expected = path.join(root, ...folderRel);
      const file = path.join(dataDir, ...folderRel, name);
      if (fs.realpathSync(path.dirname(file)) !== expected) return; // a symlink leads elsewhere
      const st = fs.lstatSync(file);
      if (!st.isFile() || now - st.mtimeMs < MIN_AGE_MS) return;
      fs.unlinkSync(file);
      removed++;
    } catch { /* absent or not removable: the next start tries again */ }
  };
  const idsIn = (...rel: string[]): string[] => {
    try { return fs.readdirSync(path.join(dataDir, ...rel)).filter((n) => /^[A-Za-z0-9_-]+$/.test(n)); } catch { return []; }
  };

  for (const id of idsIn('hooks', 'grok-homes')) {
    if (isAlive(id)) continue;
    removeIfSafe(['hooks', 'grok-homes', id, 'plugins', 'dispatch'], '.mcp.json');
    removeIfSafe(['hooks', 'grok-homes', id, 'plugins', 'dispatch', 'hooks'], 'hooks.json');
  }
  for (const id of idsIn('hooks', 'opencode-homes')) {
    if (isAlive(id)) continue;
    removeIfSafe(['hooks', 'opencode-homes', id], 'opencode.json');
  }
  let keyNames: string[] = [];
  try { keyNames = fs.readdirSync(path.join(dataDir, 'keys')); } catch { /* none */ }
  for (const name of keyNames) {
    const m = KEY_FILE.exec(name);
    if (!m || isAlive(m[1])) continue;
    removeIfSafe(['keys'], name);
  }
  return removed;
}
