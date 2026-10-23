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
