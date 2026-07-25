import Database from 'better-sqlite3';
import { initSchema } from './schema.js';

/**
 * Open (and migrate) the Dispatch database.
 *
 * WAL is worth having — it keeps readers from blocking the writer — but it needs a
 * shared-memory `-shm` file that SQLite mmaps. Network filesystems don't provide
 * coherent mmap, so on NFS/EFS `PRAGMA journal_mode=WAL` does **not** take effect.
 * It also doesn't error: the pragma just returns the mode you actually got. Ignoring
 * that return value is how a hosted box silently ends up on the rollback journal.
 *
 * This matters now because a hosted per-user box keeps $HOME (and therefore
 * ~/.dispatch/dispatch.db) on EFS, so this is the normal case there, not an edge one.
 *
 * SQLite supports WAL without the shm file when `locking_mode=EXCLUSIVE` (≥3.7.4), so
 * that's the fallback. It's safe here: server.ts holds the only connection and nothing
 * else opens dispatch.db. It's applied ONLY when plain WAL didn't take, so a local
 * daemon keeps today's behaviour and you can still open the DB in another process to
 * poke at it.
 */
export function createDatabase(path: string): Database.Database {
  const db = new Database(path);

  if (journalMode(db) !== 'wal') {
    db.pragma('locking_mode = EXCLUSIVE');
    if (journalMode(db) !== 'wal') {
      console.warn(
        `SQLite journal_mode is "${journalMode(db)}", not WAL (${path}). ` +
        'Durability is unaffected; concurrency is lower. Expected on filesystems ' +
        'without shared-memory support.',
      );
    }
  }

  db.pragma('foreign_keys = ON');
  initSchema(db);
  return db;
}

/** Request WAL and report the mode actually in effect. */
function journalMode(db: Database.Database): string {
  const result = db.pragma('journal_mode = WAL', { simple: true });
  return String(result ?? '').toLowerCase();
}
