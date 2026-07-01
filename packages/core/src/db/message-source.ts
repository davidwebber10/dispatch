import type Database from 'better-sqlite3';

/** Who actually sent a turn — mirrors structured/manager.ts's MessageSource. Kept as an
 *  independent literal here (same rationale as cc-sessions.ts's WAKE_TOOLS duplication):
 *  this is a storage-layer module and shouldn't couple to the structured session manager. */
export type MessageSource = 'user' | 'coordinator';

interface Row { uuid: string; source: MessageSource }

/**
 * Durably tag a transcript-line uuid with who sent it, so the "via Dispatch" badge
 * survives the CLI process exiting — backfillEventsFromTranscript / parseClaudeTranscript
 * read the on-disk transcript, which has no `source` field of its own (see
 * structured/manager.ts's sendMessage: the in-memory echo's `meta.source` never reaches
 * the CLI's stdin, let alone its transcript). Idempotent: re-tagging the same uuid updates
 * the source rather than erroring.
 */
export function record(db: Database.Database, terminalId: string, uuid: string, source: MessageSource): void {
  db.prepare(`INSERT INTO message_source (terminal_id, uuid, source, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(terminal_id, uuid) DO UPDATE SET source = excluded.source`)
    .run(terminalId, uuid, source, new Date().toISOString());
}

/** Look up sources for a batch of uuids on one terminal (backfill/REST hydration merge). */
export function getForUuids(db: Database.Database, terminalId: string, uuids: string[]): Map<string, MessageSource> {
  const unique = Array.from(new Set(uuids));
  if (!unique.length) return new Map();
  const placeholders = unique.map(() => '?').join(',');
  const rows = db.prepare(`SELECT uuid, source FROM message_source WHERE terminal_id = ? AND uuid IN (${placeholders})`)
    .all(terminalId, ...unique) as Row[];
  return new Map(rows.map((r) => [r.uuid, r.source]));
}

/** Every uuid already recorded for a terminal — lets the resolver (sessions/service.ts)
 *  find the newest NOT-yet-recorded real user turn when a just-completed turn had a
 *  pending source tag to resolve. */
export function listUuids(db: Database.Database, terminalId: string): Set<string> {
  const rows = db.prepare('SELECT uuid FROM message_source WHERE terminal_id = ?').all(terminalId) as { uuid: string }[];
  return new Set(rows.map((r) => r.uuid));
}
