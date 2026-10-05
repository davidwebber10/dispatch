import type Database from 'better-sqlite3';

export type LedgerKind = 'go' | 'decide' | 'do' | 'statement';
export type LedgerStatus = 'open' | 'answered' | 'parked' | 'withdrawn' | 'superseded';
export type LedgerOrigin = 'live' | 'imported';

interface LedgerRow {
  id: number;
  session_id: string;
  seq: number;
  kind: LedgerKind;
  text: string;
  author: string;
  recommendation: string | null;
  options: string | null;
  blocks: string | null;
  mission: string | null;
  status: LedgerStatus;
  quote: string | null;
  quote_message_id: number | null;
  quote_at: string | null;
  reading: string | null;
  reason: string | null;
  supersedes: number | null;
  origin: LedgerOrigin;
  created_at: string;
  updated_at: string;
}

export interface LedgerItem {
  id: number;
  sessionId: string;
  /** Counts up per project. The user sees it as `N<seq>`. */
  seq: number;
  kind: LedgerKind;
  /** The item as shown to the user. Never changes after creation (a trigger enforces it). */
  text: string;
  author: string;
  recommendation: string | null;
  options: string[] | null;
  blocks: string | null;
  mission: string | null;
  status: LedgerStatus;
  quote: string | null;
  quoteMessageId: number | null;
  quoteAt: string | null;
  reading: string | null;
  reason: string | null;
  supersedes: number | null;
  origin: LedgerOrigin;
  createdAt: string;
  updatedAt: string;
}

function rowToItem(r: LedgerRow): LedgerItem {
  let options: string[] | null = null;
  if (r.options) {
    try {
      const parsed = JSON.parse(r.options);
      if (Array.isArray(parsed)) options = parsed.map(String);
    } catch { /* malformed options read as none */ }
  }
  return {
    id: r.id,
    sessionId: r.session_id,
    seq: r.seq,
    kind: r.kind,
    text: r.text,
    author: r.author,
    recommendation: r.recommendation,
    options,
    blocks: r.blocks,
    mission: r.mission,
    status: r.status,
    quote: r.quote,
    quoteMessageId: r.quote_message_id,
    quoteAt: r.quote_at,
    reading: r.reading,
    reason: r.reason,
    supersedes: r.supersedes,
    origin: r.origin,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface CreateLedgerInput {
  sessionId: string;
  kind: LedgerKind;
  text: string;
  author: string;
  recommendation?: string | null;
  options?: string[] | null;
  blocks?: string | null;
  mission?: string | null;
  supersedes?: number | null;
  origin?: LedgerOrigin;
  status?: LedgerStatus;
  quote?: string | null;
  quoteMessageId?: number | null;
  quoteAt?: string | null;
  reading?: string | null;
  /** ISO time for created_at/updated_at. Defaults to now. */
  now?: string;
}

/**
 * Create an item with the next per-project `seq` (MAX + 1 — rows are never deleted, so an ID
 * never repeats). When `supersedes` names an item that is still open, that item becomes
 * `superseded` in the same transaction; an answered or parked item keeps its status.
 */
export function create(db: Database.Database, input: CreateLedgerInput): LedgerItem {
  const now = input.now ?? new Date().toISOString();
  return db.transaction((): LedgerItem => {
    const { next } = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM ledger_items WHERE session_id = ?')
      .get(input.sessionId) as { next: number };
    db.prepare(`INSERT INTO ledger_items
      (session_id, seq, kind, text, author, recommendation, options, blocks, mission, status,
       quote, quote_message_id, quote_at, reading, reason, supersedes, origin, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`).run(
      input.sessionId, next, input.kind, input.text, input.author,
      input.recommendation ?? null,
      input.options && input.options.length ? JSON.stringify(input.options) : null,
      input.blocks ?? null, input.mission ?? null, input.status ?? 'open',
      input.quote ?? null, input.quoteMessageId ?? null, input.quoteAt ?? null, input.reading ?? null,
      input.supersedes ?? null, input.origin ?? 'live', now, now,
    );
    if (input.supersedes !== undefined && input.supersedes !== null) {
      db.prepare("UPDATE ledger_items SET status = 'superseded', updated_at = ? WHERE session_id = ? AND seq = ? AND status = 'open'")
        .run(now, input.sessionId, input.supersedes);
    }
    return getBySeq(db, input.sessionId, next)!;
  })();
}

export function getBySeq(db: Database.Database, sessionId: string, seq: number): LedgerItem | null {
  const row = db.prepare('SELECT * FROM ledger_items WHERE session_id = ? AND seq = ?').get(sessionId, seq) as LedgerRow | undefined;
  return row ? rowToItem(row) : null;
}

/** Every item of one project, in `seq` order. */
export function listBySession(db: Database.Database, sessionId: string): LedgerItem[] {
  return (db.prepare('SELECT * FROM ledger_items WHERE session_id = ? ORDER BY seq ASC').all(sessionId) as LedgerRow[]).map(rowToItem);
}

/** The `seq` of every open item of one project, ascending. */
export function listOpenSeqs(db: Database.Database, sessionId: string): number[] {
  return (db.prepare("SELECT seq FROM ledger_items WHERE session_id = ? AND status = 'open' ORDER BY seq ASC")
    .all(sessionId) as { seq: number }[]).map((r) => r.seq);
}

export interface StatusPatch {
  status: LedgerStatus;
  quote?: string | null;
  quoteMessageId?: number | null;
  quoteAt?: string | null;
  reading?: string | null;
  reason?: string | null;
  now?: string;
}

/** Change an item's status. Fields left out of the patch keep their stored value. Never touches `text`. */
export function updateStatus(db: Database.Database, sessionId: string, seq: number, patch: StatusPatch): LedgerItem | null {
  db.prepare(`UPDATE ledger_items SET status = ?,
      quote = COALESCE(?, quote), quote_message_id = COALESCE(?, quote_message_id), quote_at = COALESCE(?, quote_at),
      reading = COALESCE(?, reading), reason = COALESCE(?, reason), updated_at = ?
    WHERE session_id = ? AND seq = ?`).run(
    patch.status, patch.quote ?? null, patch.quoteMessageId ?? null, patch.quoteAt ?? null,
    patch.reading ?? null, patch.reason ?? null, patch.now ?? new Date().toISOString(), sessionId, seq,
  );
  return getBySeq(db, sessionId, seq);
}
