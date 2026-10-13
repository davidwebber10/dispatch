/**
 * Endless Chat storage (spec 2026-10-13, section 3). The only module that touches the
 * endless_* tables. Messages and nodes are only appended (triggers refuse updates and
 * deletes); the views and a few flags live in endless_state. One writer: the daemon.
 */
import type Database from 'better-sqlite3';
import { byteLength } from './text.js';
import type { Line, NodeRef } from './tree.js';
import type { ChatView } from './view.js';

export type EndlessKind = 'user' | 'unii' | 'tool' | 'echo' | 'work' | 'note';
export interface EndlessMessage { i: number; kind: EndlessKind; text: string; size: number; project: string | null; ref: string | null; media: string[]; createdAt: number }
export interface AppendInput { kind: EndlessKind; text: string; project?: string | null; ref?: string | null; media?: string[]; createdAt?: number }
export interface SearchHit { i: number; kind: EndlessKind; project: string | null; createdAt: number; snippet: string }
export interface Page { messages: EndlessMessage[]; hasMore: boolean; hasMoreAfter: boolean }

/** Snippet highlight markers: control characters that never occur in typed text. */
export const SNIPPET_OPEN = '\u0002';
export const SNIPPET_CLOSE = '\u0003';

interface Row { i: number; kind: EndlessKind; text: string; size: number; project: string | null; ref: string | null; media: string | null; created_at: number }
const toMessage = (r: Row): EndlessMessage => ({
  i: r.i, kind: r.kind, text: r.text, size: r.size, project: r.project, ref: r.ref,
  media: r.media ? (JSON.parse(r.media) as string[]) : [], createdAt: r.created_at,
});

/** Each typed word becomes a quoted prefix term, so FTS5 syntax in the query is plain text. */
export function ftsQuery(q: string): string | null {
  const terms = q.split(/\s+/).filter(Boolean);
  if (!terms.length) return null;
  return terms.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' ');
}

export class EndlessStore {
  private total: number;
  private readonly nodes = new Map<string, string>();
  private readonly nodeStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.total = this.recount();
    this.nodeStmt = db.prepare('SELECT text FROM endless_nodes WHERE l = ? AND i = ?');
  }

  private recount(): number {
    return (this.db.prepare('SELECT COALESCE(MAX(i) + 1, 0) AS n FROM endless_messages').get() as { n: number }).n;
  }

  count(): number { return this.total; }

  /** Run `fn` in one SQLite transaction; on failure the in-memory count and cache are reloaded. */
  transaction<T>(fn: () => T): T {
    try {
      return this.db.transaction(fn)();
    } catch (err) {
      this.total = this.recount();
      this.nodes.clear();
      throw err;
    }
  }

  append(input: AppendInput): EndlessMessage {
    const i = this.total;
    const createdAt = input.createdAt ?? Date.now();
    const media = input.media ?? [];
    const size = byteLength(input.text);
    this.db.prepare('INSERT INTO endless_messages (i, kind, text, size, project, ref, media, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(i, input.kind, input.text, size, input.project ?? null, input.ref ?? null, media.length ? JSON.stringify(media) : null, createdAt);
    this.total = i + 1;
    return { i, kind: input.kind, text: input.text, size, project: input.project ?? null, ref: input.ref ?? null, media, createdAt };
  }

  get(i: number): EndlessMessage | null {
    const r = this.db.prepare('SELECT * FROM endless_messages WHERE i = ?').get(i) as Row | undefined;
    return r ? toMessage(r) : null;
  }

  page(opts: { before?: number; limit: number; project?: string | null }): Page {
    const before = opts.before ?? this.total;
    const project = opts.project ?? null;
    const rows = this.db.prepare('SELECT * FROM endless_messages WHERE i < ? AND (? IS NULL OR project = ?) ORDER BY i DESC LIMIT ?')
      .all(before, project, project, opts.limit + 1) as Row[];
    const hasMore = rows.length > opts.limit;
    return { messages: rows.slice(0, opts.limit).reverse().map(toMessage), hasMore, hasMoreAfter: false };
  }

  around(i: number, limit: number, project: string | null = null): Page {
    const half = Math.max(1, Math.floor(limit / 2));
    const older = this.db.prepare('SELECT * FROM endless_messages WHERE i <= ? AND (? IS NULL OR project = ?) ORDER BY i DESC LIMIT ?')
      .all(i, project, project, half + 1) as Row[];
    const newer = this.db.prepare('SELECT * FROM endless_messages WHERE i > ? AND (? IS NULL OR project = ?) ORDER BY i ASC LIMIT ?')
      .all(i, project, project, half + 1) as Row[];
    return {
      messages: [...older.slice(0, half).reverse(), ...newer.slice(0, half)].map(toMessage),
      hasMore: older.length > half,
      hasMoreAfter: newer.length > half,
    };
  }

  /** The last run of consecutive user messages (a long message is several rows). */
  lastUserRun(): EndlessMessage[] {
    const rows = this.db.prepare("SELECT * FROM endless_messages WHERE i <= (SELECT MAX(i) FROM endless_messages WHERE kind = 'user') ORDER BY i DESC LIMIT 64")
      .all() as Row[];
    const run: Row[] = [];
    for (const r of rows) { if (r.kind !== 'user') break; run.push(r); }
    return run.reverse().map(toMessage);
  }

  lastOfKind(kind: EndlessKind, project: string): EndlessMessage | null {
    const r = this.db.prepare('SELECT * FROM endless_messages WHERE kind = ? AND project = ? ORDER BY i DESC LIMIT 1').get(kind, project) as Row | undefined;
    return r ? toMessage(r) : null;
  }

  projectCounts(): Record<string, number> {
    const rows = this.db.prepare('SELECT project, COUNT(*) AS n FROM endless_messages WHERE project IS NOT NULL GROUP BY project').all() as { project: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.project, r.n]));
  }

  appendNode(l: number, i: number, text: string): void {
    this.db.prepare('INSERT INTO endless_nodes (l, i, text, size) VALUES (?, ?, ?, ?)').run(l, i, text, byteLength(text));
    this.nodes.set(`${l}:${i}`, text);
  }

  nodeText(l: number, i: number): string | undefined {
    const key = `${l}:${i}`;
    const hit = this.nodes.get(key);
    if (hit !== undefined) return hit;
    const r = this.nodeStmt.get(l, i) as { text: string } | undefined;
    if (r) this.nodes.set(key, r.text);
    return r?.text;
  }

  readonly isBuilt = (l: number, i: number): boolean => this.nodeText(l, i) !== undefined;

  getState(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM endless_state WHERE key = ?').get(key) as { value: string } | undefined;
    return r?.value ?? null;
  }

  setState(key: string, value: string): void {
    this.db.prepare('INSERT INTO endless_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  /** A thread Chat sent work to owes Chat one report (stage 2). Re-arming keeps one row. */
  armReport(terminalId: string, at: number = Date.now()): void {
    this.db.prepare('INSERT INTO endless_pending_reports (terminal_id, armed_at) VALUES (?, ?) ON CONFLICT(terminal_id) DO UPDATE SET armed_at = excluded.armed_at')
      .run(terminalId, at);
  }

  hasPendingReport(terminalId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM endless_pending_reports WHERE terminal_id = ?').get(terminalId);
  }

  /** Take the pending report: true once, then false. Call it inside the transaction that logs the report. */
  claimReport(terminalId: string): boolean {
    return this.db.prepare('DELETE FROM endless_pending_reports WHERE terminal_id = ?').run(terminalId).changes === 1;
  }

  pendingReports(): string[] {
    return (this.db.prepare('SELECT terminal_id FROM endless_pending_reports ORDER BY armed_at, terminal_id').all() as { terminal_id: string }[])
      .map((r) => r.terminal_id);
  }

  loadChatView(): ChatView | null {
    const raw = this.getState('view');
    if (raw === null) return null;
    return { lines: JSON.parse(raw) as Line[], batching: this.getState('view_batching') === '1' };
  }

  saveChatView(v: ChatView): void {
    this.setState('view', JSON.stringify(v.lines));
    this.setState('view_batching', v.batching ? '1' : '0');
  }

  loadCompactionView(): Line[] | null {
    const raw = this.getState('compaction_view');
    return raw === null ? null : (JSON.parse(raw) as Line[]);
  }

  saveCompactionView(lines: readonly Line[]): void {
    this.setState('compaction_view', JSON.stringify(lines));
  }

  search(q: string, opts: { project?: string | null; limit?: number } = {}): SearchHit[] {
    const match = ftsQuery(q);
    if (!match) return [];
    const project = opts.project ?? null;
    const rows = this.db.prepare(`
      SELECT m.i AS i, m.kind AS kind, m.project AS project, m.created_at AS created_at,
             snippet(endless_messages_fts, 0, ?, ?, '…', 14) AS snippet
      FROM endless_messages_fts JOIN endless_messages m ON m.i = endless_messages_fts.rowid
      WHERE endless_messages_fts MATCH ? AND (? IS NULL OR m.project = ?)
      ORDER BY m.i DESC LIMIT ?`)
      .all(SNIPPET_OPEN, SNIPPET_CLOSE, match, project, project, opts.limit ?? 50) as { i: number; kind: EndlessKind; project: string | null; created_at: number; snippet: string }[];
    return rows.map((r) => ({ i: r.i, kind: r.kind, project: r.project, createdAt: r.created_at, snippet: r.snippet }));
  }

  /** Boot recovery only (one pass): messages whose level-0 node is not built. */
  unbuiltMessages(): number[] {
    return (this.db.prepare('SELECT m.i AS i FROM endless_messages m WHERE NOT EXISTS (SELECT 1 FROM endless_nodes n WHERE n.l = 0 AND n.i = m.i) ORDER BY m.i')
      .all() as { i: number }[]).map((r) => r.i);
  }

  /** Boot recovery only (one pass): merges whose two halves are built and whose node is not. */
  readyMerges(): NodeRef[] {
    return this.db.prepare(`
      SELECT a.l + 1 AS l, a.i / 2 AS i FROM endless_nodes a
      JOIN endless_nodes b ON b.l = a.l AND b.i = a.i + 1
      WHERE a.i % 2 = 0 AND NOT EXISTS (SELECT 1 FROM endless_nodes p WHERE p.l = a.l + 1 AND p.i = a.i / 2)
      ORDER BY a.l, a.i`).all() as NodeRef[];
  }
}
