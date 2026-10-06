import type Database from 'better-sqlite3';

export type LedgerKind = 'go' | 'decide' | 'do' | 'statement';
/**
 * `proposed`: from an agent's owner-decisions block, not yet triaged by the overseer.
 * `decided_by_overseer`: a low-level call the overseer made itself (ledger_decide_self).
 */
export type LedgerStatus = 'open' | 'answered' | 'parked' | 'withdrawn' | 'superseded' | 'proposed' | 'decided_by_overseer';
export type LedgerOrigin = 'live' | 'imported';
export type LedgerSourceKind = 'plan' | 'doc' | 'agent' | 'pr' | 'issue' | 'user' | 'overseer';

/** One option of a decision card. A #62 row stores plain strings; they read back with an empty effect. */
export interface LedgerOption { label: string; effect: string }

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
  context: string | null;
  recommendation_why: string | null;
  default_text: string | null;
  source_kind: LedgerSourceKind | null;
  source_ref: string | null;
  source_section: string | null;
  source_id: string | null;
  overseer_note: string | null;
  on_default_since: string | null;
  agent_terminal_id: string | null;
  agent_decision_id: string | null;
  decided_choice: string | null;
  decided_at: string | null;
  policy: number;
  sent_at: string | null;
}

export interface LedgerItem {
  id: number;
  sessionId: string;
  /** Counts up per project. The user sees it as `N<seq>`. */
  seq: number;
  kind: LedgerKind;
  /** The item as shown to the user (the question, for a card). Never changes after creation (a trigger enforces it). */
  text: string;
  author: string;
  recommendation: string | null;
  options: LedgerOption[] | null;
  blocks: string | null;
  mission: string | null;
  status: LedgerStatus;
  quote: string | null;
  quoteMessageId: number | null;
  quoteAt: string | null;
  reading: string | null;
  /** Why the overseer withdrew the item, or why it decided the item itself. */
  reason: string | null;
  supersedes: number | null;
  origin: LedgerOrigin;
  createdAt: string;
  updatedAt: string;
  context: string | null;
  recommendationWhy: string | null;
  /** "If you do not answer". */
  defaultText: string | null;
  sourceKind: LedgerSourceKind | null;
  /** plan/doc: the relative path; agent: the agent's label; pr/issue: "#123"; user: the user's words. */
  sourceRef: string | null;
  /** The place inside the source. For an agent source: the file path, then "#" and the section. */
  sourceSection: string | null;
  /** The source's own ID, such as LR-6. A cross-reference only; never shown alone. */
  sourceId: string | null;
  overseerNote: string | null;
  onDefaultSince: string | null;
  agentTerminalId: string | null;
  agentDecisionId: string | null;
  decidedChoice: string | null;
  decidedAt: string | null;
  /** A project rule (statement items only). */
  policy: boolean;
  /** When the item first reached the user: created open, or moved from proposed to open. Null while proposed. */
  sentAt: string | null;
}

/** Read an options value in either shape: #62 plain strings, or `{ label, effect }` objects. */
export function parseOptions(raw: string | null): LedgerOption[] | null {
  if (!raw) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; } // malformed options read as none
  if (!Array.isArray(parsed)) return null;
  const out: LedgerOption[] = [];
  for (const o of parsed) {
    if (typeof o === 'string') out.push({ label: o, effect: '' });
    else if (o && typeof o === 'object' && typeof (o as any).label === 'string') {
      out.push({ label: (o as any).label, effect: typeof (o as any).effect === 'string' ? (o as any).effect : '' });
    }
  }
  return out.length ? out : null;
}

function rowToItem(r: LedgerRow): LedgerItem {
  return {
    id: r.id,
    sessionId: r.session_id,
    seq: r.seq,
    kind: r.kind,
    text: r.text,
    author: r.author,
    recommendation: r.recommendation,
    options: parseOptions(r.options),
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
    context: r.context,
    recommendationWhy: r.recommendation_why,
    defaultText: r.default_text,
    sourceKind: r.source_kind,
    sourceRef: r.source_ref,
    sourceSection: r.source_section,
    sourceId: r.source_id,
    overseerNote: r.overseer_note,
    onDefaultSince: r.on_default_since,
    agentTerminalId: r.agent_terminal_id,
    agentDecisionId: r.agent_decision_id,
    decidedChoice: r.decided_choice,
    decidedAt: r.decided_at,
    policy: r.policy === 1,
    sentAt: r.sent_at,
  };
}

export interface CreateLedgerInput {
  sessionId: string;
  kind: LedgerKind;
  text: string;
  author: string;
  recommendation?: string | null;
  options?: LedgerOption[] | null;
  blocks?: string | null;
  mission?: string | null;
  supersedes?: number | null;
  origin?: LedgerOrigin;
  status?: LedgerStatus;
  quote?: string | null;
  quoteMessageId?: number | null;
  quoteAt?: string | null;
  reading?: string | null;
  context?: string | null;
  recommendationWhy?: string | null;
  defaultText?: string | null;
  sourceKind?: LedgerSourceKind | null;
  sourceRef?: string | null;
  sourceSection?: string | null;
  sourceId?: string | null;
  overseerNote?: string | null;
  agentTerminalId?: string | null;
  agentDecisionId?: string | null;
  policy?: boolean;
  /** ISO time for created_at/updated_at (and sent_at, unless the item is proposed). Defaults to now. */
  now?: string;
}

/**
 * Create an item with the next per-project `seq` (MAX + 1 — rows are never deleted, so an ID
 * never repeats). When `supersedes` names an item that is still open or proposed, that item
 * becomes `superseded` in the same transaction; an answered or parked item keeps its status.
 * Every item except a `proposed` one reaches the user now, so `sent_at` is its creation time.
 */
export function create(db: Database.Database, input: CreateLedgerInput): LedgerItem {
  const now = input.now ?? new Date().toISOString();
  const status = input.status ?? 'open';
  return db.transaction((): LedgerItem => {
    const { next } = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM ledger_items WHERE session_id = ?')
      .get(input.sessionId) as { next: number };
    db.prepare(`INSERT INTO ledger_items
      (session_id, seq, kind, text, author, recommendation, options, blocks, mission, status,
       quote, quote_message_id, quote_at, reading, reason, supersedes, origin, created_at, updated_at,
       context, recommendation_why, default_text, source_kind, source_ref, source_section, source_id,
       overseer_note, agent_terminal_id, agent_decision_id, policy, sent_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.sessionId, next, input.kind, input.text, input.author,
      input.recommendation ?? null,
      input.options && input.options.length ? JSON.stringify(input.options) : null,
      input.blocks ?? null, input.mission ?? null, status,
      input.quote ?? null, input.quoteMessageId ?? null, input.quoteAt ?? null, input.reading ?? null,
      input.supersedes ?? null, input.origin ?? 'live', now, now,
      input.context ?? null, input.recommendationWhy ?? null, input.defaultText ?? null,
      input.sourceKind ?? null, input.sourceRef ?? null, input.sourceSection ?? null, input.sourceId ?? null,
      input.overseerNote ?? null, input.agentTerminalId ?? null, input.agentDecisionId ?? null,
      input.policy ? 1 : 0, status === 'proposed' ? null : now,
    );
    if (input.supersedes !== undefined && input.supersedes !== null) {
      db.prepare("UPDATE ledger_items SET status = 'superseded', updated_at = ? WHERE session_id = ? AND seq = ? AND status IN ('open', 'proposed')")
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

/** The `seq` of every proposed (not yet triaged) item of one project, ascending. */
export function listProposedSeqs(db: Database.Database, sessionId: string): number[] {
  return (db.prepare("SELECT seq FROM ledger_items WHERE session_id = ? AND status = 'proposed' ORDER BY seq ASC")
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
