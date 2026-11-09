// packages/core/src/journal/journal.ts
//
// The message journal of the daemon (engineering program W3-D): one durable row for each FINISHED
// item of a thread. The structured socket replay, the REST page (routes/journal.ts) and the resume
// cursor (`?after=seq`) all read it through `page`, so the three cannot disagree.
//
// A row is written when its item is finished (see recorder.ts): a user message that the daemon
// accepted, a whole assistant message, a tool call, a tool result, a result footer, a notice.
// Stream deltas are never written. Nothing here runs on a timer and nothing scans: the size bound
// of a thread is applied by the append that passes it.
//
// `seq` is the sequence of the JOURNAL. It is not the status sequence of StatusService
// (`statusSeq` in the code that holds both).

import type Database from 'better-sqlite3';
import { GAP_PREFIX, prepareJournal, type JournalKind, type JournalRow, type JournalStatements } from './db.js';

export type { JournalKind } from './db.js';

/** The most characters of JSON that one payload keeps (256 KB). A larger payload is cut and flagged. */
export const MAX_PAYLOAD_CHARS = 256 * 1024;
/** The most rows that one thread keeps. The oldest rows go first. */
export const MAX_THREAD_ROWS = 50_000;
/** The most payload characters that one thread keeps (64 MB). The oldest rows go first. */
export const MAX_THREAD_BYTES = 64 * 1024 * 1024;
/** A trim removes rows down to this part of the limit, so the next appends do not trim again. */
const TRIM_TO = 0.8;
export const DEFAULT_PAGE_LIMIT = 120;
export const MAX_PAGE_LIMIT = 500;

const CUT_MARK = '\n… [cut by Dispatch: this item was over the journal limit]';
/** The flag on a payload that was cut. It is part of the payload, so every reader gets it. */
export const CUT_FLAG = 'journal_cut';

export interface JournalInput {
  kind: JournalKind;
  /** The harness's own id of the item. The same id for a thread updates the row and keeps the sequence. */
  nativeId?: string;
  /** The item as JSON data: the Claude-shaped event that a client folds into the chat. */
  payload: unknown;
  /** The Idempotency-Key of the request that made the item. A repeated key is refused. */
  idemKey?: string;
  /** ISO time. Default: now. */
  at?: string;
}

export interface JournalItem {
  seq: number;
  kind: JournalKind;
  nativeId: string | null;
  payload: unknown;
  at: string;
  /** True when the payload was over the limit and was cut. */
  truncated: boolean;
}

export interface JournalPage {
  /** Oldest first. */
  items: JournalItem[];
  /** The oldest sequence that the journal can give for the thread, or 0 when it has none. Below it, a
   *  thread with a transcript (Claude, Codex) reads the transcript route. */
  firstSeq: number;
  /** The newest sequence of the thread, or 0. */
  lastSeq: number;
  /** `afterSeq`: newer rows exist after the page. Otherwise: older rows exist before the page. */
  hasMore: boolean;
}

export interface JournalPageOptions {
  beforeSeq?: number;
  afterSeq?: number;
  limit?: number;
}

export interface JournalOptions {
  maxPayloadChars?: number;
  maxThreadRows?: number;
  maxThreadBytes?: number;
}

/** `append` with an Idempotency-Key that the thread has already. `seq` is the row that holds the key. */
export class JournalDuplicateKeyError extends Error {
  constructor(readonly terminalId: string, readonly key: string, readonly seq: number) {
    super(`The idempotency key was used already (thread ${terminalId}, item ${seq})`);
    this.name = 'JournalDuplicateKeyError';
  }
}

interface ThreadStats { rows: number; bytes: number }

export class MessageJournal {
  private readonly q: JournalStatements;
  private readonly maxPayloadChars: number;
  private readonly maxThreadRows: number;
  private readonly maxThreadBytes: number;
  /** Rows and bytes of the threads this instance wrote to. Read from the database on first use. */
  private readonly known = new Map<string, ThreadStats>();
  private readonly appendTx: (terminalId: string, item: JournalInput) => number;

  constructor(db: Database.Database, opts: JournalOptions = {}) {
    this.q = prepareJournal(db);
    this.maxPayloadChars = Math.max(64, opts.maxPayloadChars ?? MAX_PAYLOAD_CHARS);
    this.maxThreadRows = Math.max(2, opts.maxThreadRows ?? MAX_THREAD_ROWS);
    this.maxThreadBytes = Math.max(1, opts.maxThreadBytes ?? MAX_THREAD_BYTES);
    this.appendTx = db.transaction((terminalId: string, item: JournalInput) => this.appendNow(terminalId, item));
  }

  /**
   * Write one finished item. Returns its sequence: 1, 2, 3 for each thread, never a repeat.
   * The same `nativeId` for the thread updates the row and returns the sequence it has.
   * A repeated `idemKey` throws JournalDuplicateKeyError and writes nothing.
   */
  append(terminalId: string, item: JournalInput): number {
    return this.appendTx(terminalId, item);
  }

  private appendNow(terminalId: string, item: JournalInput): number {
    if (item.idemKey) {
      const held = this.q.byKey.get(terminalId, item.idemKey) as JournalRow | undefined;
      if (held) throw new JournalDuplicateKeyError(terminalId, item.idemKey, held.seq);
    }
    const { json } = cutPayload(item.payload, this.maxPayloadChars);
    if (item.nativeId) {
      const row = this.q.byNative.get(terminalId, item.nativeId) as { seq: number; bytes: number } | undefined;
      if (row) {
        this.q.updateNative.run({ terminal_id: terminalId, seq: row.seq, kind: item.kind, payload: json, bytes: json.length });
        const stats = this.known.get(terminalId);
        if (stats) stats.bytes += json.length - row.bytes;
        if (item.idemKey) this.q.setKey.run(item.idemKey, terminalId, row.seq);
        return row.seq;
      }
    }
    const stats = this.statsOf(terminalId);
    const { seq } = this.q.insert.get({
      terminal_id: terminalId, kind: item.kind, native_id: item.nativeId ?? null, payload: json,
      idem_key: item.idemKey ?? null, at: item.at ?? new Date().toISOString(), bytes: json.length,
    }) as { seq: number };
    stats.rows += 1; stats.bytes += json.length;
    if (stats.rows > this.maxThreadRows || stats.bytes > this.maxThreadBytes) this.trim(terminalId);
    return seq;
  }

  /** A window of the thread's items, oldest first. With no option: the newest `limit` items. */
  page(terminalId: string, opts: JournalPageOptions = {}): JournalPage {
    const limit = Math.min(MAX_PAGE_LIMIT, Math.max(1, Math.floor(opts.limit ?? DEFAULT_PAGE_LIMIT)));
    const floor = this.floorOf(terminalId);
    const lastSeq = (this.q.lastSeq.get(terminalId) as { seq: number }).seq;
    const firstSeq = (this.q.firstSeqAbove.get(terminalId, floor) as { seq: number }).seq;
    let rows: JournalRow[];
    if (opts.afterSeq !== undefined) {
      rows = this.q.after.all(terminalId, Math.max(floor, Math.floor(opts.afterSeq)), limit + 1) as JournalRow[];
      const hasMore = rows.length > limit;
      return { items: rows.slice(0, limit).map(toItem), firstSeq, lastSeq, hasMore };
    }
    rows = opts.beforeSeq !== undefined
      ? this.q.before.all(terminalId, floor, Math.floor(opts.beforeSeq), limit + 1) as JournalRow[]
      : this.q.newest.all(terminalId, floor, limit + 1) as JournalRow[];
    const hasMore = rows.length > limit;
    return { items: rows.slice(0, limit).reverse().map(toItem), firstSeq, lastSeq, hasMore };
  }

  /** The newest sequence of the thread, or 0 when the journal has no row for it. */
  lastSeq(terminalId: string): number {
    return (this.q.lastSeq.get(terminalId) as { seq: number }).seq;
  }

  /** Remove every row of the thread (the thread was deleted). The trigger of the migration does the same. */
  removeThread(terminalId: string): void {
    this.q.deleteThread.run(terminalId);
    this.known.delete(terminalId);
  }

  /** The sequence of the row with this native id, or 0. */
  seqOfNative(terminalId: string, nativeId: string): number {
    return (this.q.byNative.get(terminalId, nativeId) as { seq: number } | undefined)?.seq ?? 0;
  }

  /** Give a row that has no native id one, with the payload that carries it. False when the row has one already. */
  setNative(terminalId: string, seq: number, nativeId: string, payload: unknown): boolean {
    if (this.seqOfNative(terminalId, nativeId)) return false;
    const { json } = cutPayload(payload, this.maxPayloadChars);
    return this.q.setNative.run(nativeId, json, json.length, terminalId, seq).changes > 0;
  }

  /** The item that holds this Idempotency-Key, or null. */
  findKey(terminalId: string, key: string): JournalItem | null {
    const row = this.q.byKey.get(terminalId, key) as JournalRow | undefined;
    return row ? toItem(row) : null;
  }

  /** Keep an Idempotency-Key on a row that exists. False when the thread holds the key already, or the row has a key. */
  setKey(terminalId: string, seq: number, key: string): boolean {
    if (this.q.byKey.get(terminalId, key)) return false;
    return this.q.setKey.run(key, terminalId, seq).changes > 0;
  }

  /**
   * Mark that the thread's history went on outside the journal (a transcript holds items that the
   * journal does not). A page never goes below the newest mark: `firstSeq` is the row after it, and
   * the client reads the transcript route for what is older.
   */
  markGap(terminalId: string): number {
    const next = this.lastSeq(terminalId) + 1;
    return this.append(terminalId, { kind: 'notice', nativeId: `${GAP_PREFIX}${next}`, payload: { type: 'journal', subtype: 'gap' } });
  }

  /** Rows and payload characters of one thread. */
  stats(terminalId: string): { rows: number; bytes: number } {
    const row = this.q.stats.get(terminalId) as { n: number; bytes: number };
    return { rows: row.n, bytes: row.bytes };
  }

  /** Rows, payload characters and threads of the whole journal (diagnostics, the growth check). */
  totals(): { rows: number; bytes: number; threads: number } {
    const row = this.q.totals.get() as { n: number; bytes: number; threads: number };
    return { rows: row.n, bytes: row.bytes, threads: row.threads };
  }

  /**
   * Remove the oldest rows of a thread until it is under the limits (or under `opts`, for a manual
   * trim). The newest row always stays, so the sequence of the thread never starts again.
   * Returns how many rows were removed. `append` calls this when a thread passes a limit.
   */
  trim(terminalId: string, opts: { maxRows?: number; maxBytes?: number } = {}): number {
    const real = this.stats(terminalId);
    const rowTarget = opts.maxRows ?? Math.floor(this.maxThreadRows * TRIM_TO);
    const byteTarget = opts.maxBytes ?? Math.floor(this.maxThreadBytes * TRIM_TO);
    let rows = real.rows;
    let bytes = real.bytes;
    let cutoff = 0;
    let removed = 0;
    const last = this.lastSeq(terminalId);
    while ((rows > Math.max(1, rowTarget) || bytes > byteTarget) && rows > 1) {
      const batch = this.q.oldest.all(terminalId, 500) as { seq: number; bytes: number }[];
      let progress = false;
      for (const row of batch) {
        if (row.seq <= cutoff) continue;
        if (row.seq >= last || (rows <= Math.max(1, rowTarget) && bytes <= byteTarget)) break;
        cutoff = row.seq; rows -= 1; bytes -= row.bytes; removed += 1; progress = true;
      }
      if (!progress) break;
      this.q.deleteUpTo.run(terminalId, cutoff);
    }
    this.known.set(terminalId, { rows, bytes });
    return removed;
  }

  private statsOf(terminalId: string): ThreadStats {
    let stats = this.known.get(terminalId);
    if (!stats) { stats = this.stats(terminalId); this.known.set(terminalId, stats); }
    return stats;
  }

  private floorOf(terminalId: string): number {
    return (this.q.floor.get(terminalId) as { seq: number }).seq;
  }
}

function toItem(row: JournalRow): JournalItem {
  let payload: unknown = null;
  try { payload = JSON.parse(row.payload); } catch { payload = null; }
  const truncated = typeof payload === 'object' && payload !== null && (payload as Record<string, unknown>)[CUT_FLAG] === true;
  return { seq: row.seq, kind: row.kind, nativeId: row.native_id, payload, at: row.at, truncated };
}

/**
 * The JSON of a payload, at most `limit` characters. A payload over the limit loses the ends of
 * its longest strings (a tool output, a pasted file), in rounds, until it fits; it is then flagged
 * with `journal_cut: true`. The shape of the payload stays, so a client folds it as before.
 */
export function cutPayload(payload: unknown, limit: number): { json: string; truncated: boolean } {
  let json = stringify(payload);
  if (json.length <= limit) return { json, truncated: false };
  let cap = Math.floor(limit / 2);
  for (let round = 0; round < 16 && json.length > limit; round++) {
    const cut = shorten(payload, cap);
    json = stringify(typeof cut === 'object' && cut !== null && !Array.isArray(cut) ? { ...(cut as object), [CUT_FLAG]: true } : cut);
    cap = Math.floor(cap / 2);
  }
  if (json.length > limit) json = JSON.stringify({ type: 'journal', subtype: 'cut', [CUT_FLAG]: true });
  return { json, truncated: true };
}

function stringify(value: unknown): string {
  try { return JSON.stringify(value) ?? 'null'; } catch { return 'null'; }
}

function shorten(value: unknown, cap: number): unknown {
  if (typeof value === 'string') return value.length > cap ? value.slice(0, Math.max(0, cap - CUT_MARK.length)) + CUT_MARK : value;
  if (Array.isArray(value)) return value.map((v) => shorten(v, cap));
  if (typeof value === 'object' && value !== null) {
    const o = value as Record<string, unknown>;
    // Half of a base64 picture is not a picture: the source goes whole, and the client shows no image.
    if (o.type === 'base64' && typeof o.data === 'string' && o.data.length > cap) return { type: 'cut', media_type: o.media_type };
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) out[k] = shorten(v, cap);
    return out;
  }
  return value;
}
