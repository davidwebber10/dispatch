// packages/core/src/privsep/migrate.ts
// First start of a box that existed before privilege separation (design section 9). Its old data
// directory (`$HOME/.dispatch`) holds the daemon's state next to harness files, all owned by one
// user. The private entries move to the state root; the harness files stay.
//
// The steps are idempotent and safe to interrupt at any point:
//   1. marker present                        -> go to 4
//   2. an old database exists, the import is allowed, and the state root holds no database yet
//                                            -> copy private entries to state/.incoming, rename in
//   3. write the marker (also when there is no old database: a new box)
//   4. remove the private entries from the old directory
// An old database with the import NOT allowed is left alone, with no marker: nothing is deleted
// that was not copied. A database that appears in the home AFTER the marker exists is never imported.
import fs from 'node:fs';
import path from 'node:path';

export const MIGRATION_MARKER = 'migrated-from-home';
const INCOMING = '.incoming';

/**
 * Entries of the old data directory that STAY in the home: a harness writes them. Everything else
 * is daemon state. A new name is private by default.
 */
export const AGENT_ENTRIES: readonly string[] = ['claude-accounts', 'codex-accounts', 'chat', 'tools', 'grok-homes', 'inbox'];

/**
 * Entries that are neither moved nor kept: the daemon writes them again at each start, in the agent
 * run dir. They are removed from the home.
 */
export const REGENERATED_ENTRIES: readonly string[] = ['keys', 'prompts', 'preload', 'bin', 'hooks', 'run', 'daemon.pid', 'listen.json', 'path-debug.log', 'access-token'];

const isThreadMcpFile = (name: string) => /^thread-[A-Za-z0-9_-]+\.mcp\.json$/.test(name);

export type EntryKind = 'agent' | 'regenerated' | 'private';

export function classifyEntry(name: string): EntryKind {
  if (AGENT_ENTRIES.includes(name)) return 'agent';
  if (REGENERATED_ENTRIES.includes(name) || isThreadMcpFile(name)) return 'regenerated';
  return 'private';
}

export interface MigrationOptions {
  /** The old data directory (`$HOME/.dispatch`). */
  legacyDir: string;
  /** The state root. Must exist. */
  stateDir: string;
  /** The platform said this box existed before (DISPATCH_MIGRATE_LEGACY_HOME=1). */
  allowImport: boolean;
  log?: (line: string) => void;
}

export interface MigrationResult {
  imported: string[];
  removed: string[];
  /** Why nothing was imported, when nothing was. */
  skipped?: 'already-migrated' | 'not-allowed' | 'no-legacy-state' | 'state-not-empty';
}

/** Copy a file, folder or link without following links (a link is copied as a link). */
function copyEntry(from: string, to: string): void {
  const st = fs.lstatSync(from);
  if (st.isSymbolicLink()) { fs.symlinkSync(fs.readlinkSync(from), to); return; }
  if (st.isDirectory()) {
    fs.mkdirSync(to, { mode: 0o700 });
    for (const n of fs.readdirSync(from)) copyEntry(path.join(from, n), path.join(to, n));
    return;
  }
  if (!st.isFile()) return; // sockets, pipes and devices are not state
  fs.copyFileSync(from, to);
  fs.chmodSync(to, 0o600);
}

function fsyncDir(dir: string): void {
  try { const fd = fs.openSync(dir, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } } catch { /* not every file system allows it */ }
}

export function migrateLegacyHome(o: MigrationOptions): MigrationResult {
  const log = o.log ?? (() => undefined);
  const marker = path.join(o.stateDir, MIGRATION_MARKER);
  const result: MigrationResult = { imported: [], removed: [] };
  let names: string[] = [];
  try {
    const st = fs.lstatSync(o.legacyDir);
    // A link in place of the old directory is a workload's doing: never read through it.
    if (st.isDirectory()) names = fs.readdirSync(o.legacyDir);
  } catch { /* no old directory */ }

  const stateHasData = (() => { try { return fs.statSync(path.join(o.stateDir, 'dispatch.db')).size > 0; } catch { return false; } })();
  if (fs.existsSync(marker)) {
    result.skipped = 'already-migrated';
  } else if (!names.includes('dispatch.db')) {
    result.skipped = 'no-legacy-state';
  } else if (!o.allowImport) {
    result.skipped = 'not-allowed';
    log('privsep: the home holds an old data directory, and the import is not allowed for this box; it is left as it is');
  } else if (stateHasData) {
    result.skipped = 'state-not-empty';
    log('privsep: the home holds an old data directory, but this box already has state; the old one is not imported');
  } else {
    const incoming = path.join(o.stateDir, INCOMING);
    fs.rmSync(incoming, { recursive: true, force: true }); // an interrupted copy starts again
    fs.mkdirSync(incoming, { mode: 0o700 });
    // The database goes LAST: it is what "this box has state" is read from, so an interruption
    // before it leaves the import to be repeated in full, and one after it has nothing left to move.
    const mine = names.filter((n) => classifyEntry(n) === 'private' && n !== 'dispatch.db');
    mine.push('dispatch.db');
    for (const n of mine) copyEntry(path.join(o.legacyDir, n), path.join(incoming, n));
    fsyncDir(incoming);
    for (const n of mine) {
      const dest = path.join(o.stateDir, n);
      // The state root may hold an EMPTY database file (created before the first open), never data.
      fs.rmSync(dest, { recursive: true, force: true });
      fs.renameSync(path.join(incoming, n), dest);
      result.imported.push(n);
    }
    fs.rmSync(incoming, { recursive: true, force: true });
    fsyncDir(o.stateDir);
    log(`privsep: imported ${mine.length} entries of the old data directory`);
  }

  // The marker says "the home's copy is not the state any more": after an import, on a box with no
  // old state, and on a box that already has state of its own. Never after 'not-allowed'.
  if (!fs.existsSync(marker) && result.skipped !== 'not-allowed') {
    fs.writeFileSync(marker, `${new Date().toISOString()}\n`, { mode: 0o600 });
    fsyncDir(o.stateDir);
  }

  // Step 4, every start: nothing private stays where a workload reads it.
  if (fs.existsSync(marker)) {
    for (const n of names) {
      if (classifyEntry(n) === 'agent') continue;
      try { fs.rmSync(path.join(o.legacyDir, n), { recursive: true, force: true }); result.removed.push(n); } catch (err) { log(`privsep: could not remove ${n} from the old data directory: ${(err as Error).message}`); }
    }
  }
  return result;
}
