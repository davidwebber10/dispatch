/**
 * The decision ledger (structured-recap spec, Units 2 and 3): the rules the daemon enforces.
 *
 * 1. Only the project's overseer can change the ledger: the caller must be a non-archived
 *    `config.role === 'coordinator'` terminal in the same session (403 otherwise).
 * 2. A claim about the user needs a checked quote (answered, parked, a statement).
 * 3. Item text never changes; a wider scope is a new item with `supersedes`.
 * 4. Without a quote, the overseer can close an item only as `withdrawn`, with a reason.
 * 5. Imported items stay "Imported, not checked" until the user confirms one and the overseer
 *    records that quote — so an unchecked imported `answered` or `parked` item can be resolved
 *    once more. A `withdrawn` or `superseded` item is always closed, imported or not (409).
 * 6. A leading "ok" never counts (see ledger-quote.ts).
 *
 * Decision cards (spec 2026-10-06, Unit 2): `add`, `importItems` and the agent-block path apply
 * the same card checks (ledger-checks.ts) — required fields, one decision per card, real sources —
 * and a project rule (`note` with `policy`) needs the user's checked words.
 */
import type Database from 'better-sqlite3';
import * as terminalsDb from '../db/terminals.js';
import * as sessionsDb from '../db/sessions.js';
import * as ledgerDb from '../db/ledger.js';
import * as messagesDb from '../db/coordinator-messages.js';
import { findQuote, GO_APPROVAL_ERROR, namesGoApproval, OK_ONLY_ERROR } from './ledger-quote.js';
import {
  isUnchecked, projectRules, renderAddLine, renderCard, renderDefaultLine, renderHandoffBlock, renderItem, renderLedgerSections,
  renderOverseerDecisionLine, renderRecapPaste, renderRulesList, renderUntitledList, type RenderContext,
} from './ledger-render.js';
import { buildLedgerCard, type LedgerCard } from './ledger-card.js';
import { createRemoteReader } from './github-link.js';
import {
  cardFieldsError, findProjectPath, gitWorktrees, holdsSeveralDecisions, isIssueRef, missingCardFields,
  isUserSourceKind, ONE_DECISION_ERROR, ONLY_USER_ERROR, onlyUserCanDecide, sourceComplete, sourceMissingError, TITLE_MISSING_ERROR,
  titleProblem, type CardFieldsInput,
} from './ledger-checks.js';

export const NOT_OVERSEER_ERROR = "Only the project's overseer can change the ledger.";
export const QUOTE_NOT_FOUND_STATEMENT_ERROR = "Quote not found in the user's messages to you. Do not record it. Ask the user.";
export function quoteNotFoundAfterError(seq: number): string {
  return `Quote not found in the user's messages to you after N${seq} was created. Do not record it. Ask the user.`;
}

/** Coordinator config keys this feature owns. */
export const LAST_RECAP_KEY = 'lastRecapAt';
export const INTERIM_DUE_KEY = 'interimDueAt';

/** An error with the HTTP status the route returns, plus extra JSON fields for the body. */
export class LedgerError extends Error {
  constructor(readonly status: number, message: string, readonly body: Record<string, unknown> = {}) {
    super(message);
  }
}

/** "N12", "n12" or "12" (or the number 12) → 12. Anything else → null. */
export function parseLedgerId(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isInteger(raw) && raw > 0 ? raw : null;
  if (typeof raw !== 'string') return null;
  const m = raw.trim().match(/^N?(\d+)$/i);
  return m && Number(m[1]) > 0 ? Number(m[1]) : null;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/**
 * The title of an item (titles spec 2026-10-09, Unit 1), trimmed; undefined when none is given. A
 * missing `required` title (Unit 2) and a title that breaks a rule are 422s with the fixed text, in
 * the shape of the card-field errors (`body` rides along, as `{ item: i }` for an import).
 */
function readTitle(raw: unknown, body: Record<string, unknown> = {}, required = false): string | undefined {
  const title = str(raw);
  if (title === undefined) {
    if (required) throw new LedgerError(422, TITLE_MISSING_ERROR, body);
    return undefined;
  }
  const problem = titleProblem(title);
  if (problem) throw new LedgerError(422, problem, body);
  return title;
}

/** Options in either shape: plain strings (#62) or `{ label, effect }`. A string reads as a label with no effect. */
function optionList(v: unknown, field: string): ledgerDb.LedgerOption[] | undefined {
  if (v === undefined || v === null) return undefined;
  const bad = () => new LedgerError(400, `${field} must be an array of { label, effect } objects`);
  if (!Array.isArray(v)) throw bad();
  const list: ledgerDb.LedgerOption[] = [];
  for (const x of v) {
    if (typeof x === 'string') { if (x.trim()) list.push({ label: x.trim(), effect: '' }); continue; }
    if (!x || typeof x !== 'object') throw bad();
    const label = typeof (x as any).label === 'string' ? (x as any).label.trim() : '';
    const effect = typeof (x as any).effect === 'string' ? (x as any).effect.trim() : '';
    list.push({ label, effect });
  }
  return list.length ? list : undefined;
}

/** The card fields of a checked item, ready for ledgerDb.create. */
export type CardFields = Pick<ledgerDb.CreateLedgerInput,
  'context' | 'options' | 'recommendation' | 'recommendationWhy' | 'defaultText' | 'sourceKind' | 'sourceRef'
  | 'sourceSection' | 'sourceId' | 'overseerNote'>;

const OPEN_KINDS = new Set(['go', 'decide', 'do']);
const IMPORT_KINDS = new Set(['go', 'decide', 'do', 'statement']);
const IMPORT_STATUSES = new Set(['open', 'answered', 'parked']);

export class LedgerService {
  private readonly clock: () => number;
  private readonly timeZone?: string;
  private readonly listWorktrees: (dir: string) => string[];
  private readonly onChange?: (sessionId: string) => void;
  private readonly githubRepo: (dir: string) => string | null;

  /**
   * `onChange` (pinned card spec 2026-10-08, Unit 3) runs after every successful write, with the
   * project; server.ts turns it into the `ledger:changed` event. Its failure never fails the write.
   * `githubRepo` (titles and source panel spec 2026-10-09, Unit 5) gives a project folder's GitHub
   * repo for the PR and issue links on the card; by default it reads the remote, cached 10 minutes.
   */
  constructor(
    private readonly db: Database.Database,
    opts: {
      clock?: () => number; timeZone?: string; listWorktrees?: (dir: string) => string[]; onChange?: (sessionId: string) => void;
      githubRepo?: (dir: string) => string | null;
    } = {},
  ) {
    this.clock = opts.clock ?? (() => Date.now());
    this.timeZone = opts.timeZone;
    this.listWorktrees = opts.listWorktrees ?? gitWorktrees;
    this.onChange = opts.onChange;
    this.githubRepo = opts.githubRepo ?? createRemoteReader({ clock: this.clock });
  }

  private nowIso(): string {
    return new Date(this.clock()).toISOString();
  }

  /** Tell the listener that the project's ledger changed. Never throws. */
  private changed(sessionId: string): void {
    try {
      this.onChange?.(sessionId);
    } catch (err) {
      console.error(`ledger: the change listener failed for ${sessionId}; the write stands`, err);
    }
  }

  private ctx(sessionId: string): RenderContext {
    return { now: this.clock(), timeZone: this.timeZone, lookup: (seq) => ledgerDb.getBySeq(this.db, sessionId, seq) };
  }

  /** Rule 1. Returns the overseer's terminal row. */
  assertOverseer(sessionId: string, caller: unknown): terminalsDb.TerminalRow {
    const row = typeof caller === 'string' && caller ? terminalsDb.getById(this.db, caller) : null;
    let cfg: Record<string, any> = {};
    try { cfg = JSON.parse(row?.config || '{}'); } catch { /* default {} */ }
    if (!row || row.archived_at || row.session_id !== sessionId || cfg.role !== 'coordinator') {
      throw new LedgerError(403, NOT_OVERSEER_ERROR);
    }
    return row;
  }

  private requireItem(sessionId: string, rawId: unknown): ledgerDb.LedgerItem {
    const seq = parseLedgerId(rawId);
    if (seq === null) throw new LedgerError(400, 'id must be a ledger item ID such as N12');
    const item = ledgerDb.getBySeq(this.db, sessionId, seq);
    if (!item) throw new LedgerError(404, `Unknown ledger item: N${seq}`);
    return item;
  }

  private userMessages(overseerId: string, after: string | null) {
    return messagesDb.listUserMessages(this.db, overseerId, after);
  }

  /** The project's working directory and its git worktrees: where a plan or doc source may live. */
  private projectRoots(sessionId: string): string[] {
    const dir = sessionsDb.getById(this.db, sessionId)?.working_dir;
    if (!dir) return [];
    return [dir, ...this.listWorktrees(dir).filter((w) => w !== dir)];
  }

  /** A thread of this project (archived ones included), by ID or label, whose role passes `fits`. */
  private findThreadWhere(sessionId: string, ref: string, fits: (role: unknown) => boolean): { id: string; label: string } | null {
    const rows = this.db.prepare('SELECT id, label, config FROM terminals WHERE session_id = ?').all(sessionId) as
      { id: string; label: string | null; config: string | null }[];
    for (const r of rows) {
      let cfg: Record<string, any> = {};
      try { cfg = JSON.parse(r.config || '{}'); } catch { /* default {} */ }
      if (!fits(cfg.role)) continue;
      if (r.id === ref || (r.label ?? '') === ref) return { id: r.id, label: r.label || ref };
    }
    return null;
  }

  /** An agent thread of this project (archived ones included), by ID or label. Never one of the user's own threads. */
  private findAgent(sessionId: string, ref: string): { id: string; label: string } | null {
    return this.findThreadWhere(sessionId, ref, (role) => role === 'agent');
  }

  /**
   * One of the user's own threads of this project (archived ones included), by ID or label: neither
   * an agent nor the overseer (overseer memory scope spec 2026-10-07, Unit 4).
   */
  private findUserThread(sessionId: string, ref: string): { id: string; label: string } | null {
    return this.findThreadWhere(sessionId, ref, (role) => role !== 'agent' && role !== 'coordinator');
  }

  /**
   * The card checks of Unit 2 (rules 1 to 3) for one item. Throws a 422 with the fixed text on the
   * first failed check (`body` rides along in the error body); otherwise returns the stored fields.
   * `overseerId` is the overseer whose user messages a `user` source is checked against.
   */
  checkCard(
    sessionId: string,
    overseerId: string | null,
    kind: ledgerDb.LedgerKind,
    question: string,
    input: CardFieldsInput & { note?: unknown },
    body: Record<string, unknown> = {},
  ): CardFields {
    const fail = (message: string) => new LedgerError(422, message, body);
    const isCard = kind === 'decide' || kind === 'go';
    if (isCard) {
      const missing = missingCardFields(kind, input);
      if (missing.length) throw fail(cardFieldsError(missing));
      if (holdsSeveralDecisions(question)) throw fail(ONE_DECISION_ERROR);
    }
    const fields: CardFields = {
      context: str(input.context),
      options: optionList(input.options, 'options'),
      recommendation: str(input.recommendation),
      recommendationWhy: str(input.why),
      defaultText: str(input.default),
      overseerNote: str(input.note),
    };
    if (input.source === undefined || input.source === null) return fields;
    if (!sourceComplete(input.source)) throw fail(cardFieldsError(['source']));
    const src = input.source as Record<string, unknown>;
    const sourceKind = src.kind as ledgerDb.LedgerSourceKind;
    const ref = str(src.ref) ?? '';
    let sourceRef: string | undefined = ref || undefined;
    switch (sourceKind) {
      case 'plan':
      case 'doc': {
        const found = findProjectPath(ref, this.projectRoots(sessionId));
        if (!found) throw fail(sourceMissingError(ref));
        sourceRef = found;
        break;
      }
      case 'agent': {
        const agent = this.findAgent(sessionId, ref);
        if (!agent) throw fail(sourceMissingError(ref));
        sourceRef = agent.label;
        break;
      }
      case 'thread': {
        const thread = this.findUserThread(sessionId, ref);
        if (!thread) throw fail(sourceMissingError(ref));
        sourceRef = thread.label;
        break;
      }
      case 'pr':
      case 'issue':
        if (!isIssueRef(ref)) throw fail(sourceMissingError(ref));
        break;
      case 'user': {
        const match = findQuote(ref, overseerId ? this.userMessages(overseerId, null) : [], { after: null });
        if (!match.ok) throw fail(match.reason === 'ok_only' ? OK_ONLY_ERROR : QUOTE_NOT_FOUND_STATEMENT_ERROR);
        sourceRef = match.quote;
        break;
      }
      case 'overseer':
        break;
    }
    return { ...fields, sourceKind, sourceRef, sourceSection: str(src.section), sourceId: str(src.id) };
  }

  add(sessionId: string, caller: unknown, input: Record<string, unknown>): { id: string; line: string } {
    const overseer = this.assertOverseer(sessionId, caller);
    const kind = input.kind;
    if (typeof kind !== 'string' || !OPEN_KINDS.has(kind)) throw new LedgerError(400, "kind must be 'go', 'decide' or 'do'");
    const text = str(input.text);
    if (!text) throw new LedgerError(400, 'text is required');
    const title = readTitle(input.title, {}, true); // Unit 2: every kind ledger_add takes needs one
    let supersedes: number | undefined;
    if (input.supersedes !== undefined && input.supersedes !== null && input.supersedes !== '') {
      supersedes = this.requireItem(sessionId, input.supersedes).seq;
    }
    const card = this.checkCard(sessionId, overseer.id, kind as ledgerDb.LedgerKind, text, input);
    const item = ledgerDb.create(this.db, {
      sessionId,
      kind: kind as ledgerDb.LedgerKind,
      text,
      title,
      author: str(input.author) ?? 'overseer',
      ...card,
      blocks: str(input.blocks),
      mission: str(input.mission),
      supersedes,
      now: this.nowIso(),
    });
    this.changed(sessionId);
    // Pinned card spec 2026-10-08, Unit 5: the chat gets one line; the full card is on the pinned card.
    return { id: `N${item.seq}`, line: renderAddLine(item) };
  }

  resolve(sessionId: string, caller: unknown, input: Record<string, unknown>): { id: string; status: string; line: string } {
    const overseer = this.assertOverseer(sessionId, caller);
    const status = input.status;
    if (status !== 'answered' && status !== 'parked' && status !== 'withdrawn') {
      throw new LedgerError(400, "status must be 'answered', 'parked' or 'withdrawn'");
    }
    const item = this.requireItem(sessionId, input.id);
    // Rule 5: only an unchecked imported answered/parked item can be resolved once more;
    // withdrawn and superseded are always closed, imported or not.
    const confirmable = isUnchecked(item) && (item.status === 'answered' || item.status === 'parked');
    // Decision cards, Unit 4: a reversal sets an overseer's own decision to answered, with the
    // user's checked quote from after the decision. A proposed item can be closed like an open one.
    const reversal = item.status === 'decided_by_overseer' && status === 'answered';
    const live = item.status === 'open' || item.status === 'proposed';
    if (!live && !confirmable && !reversal) {
      throw new LedgerError(409, `N${item.seq} is already ${item.status}.`, { status: item.status });
    }
    const reading = str(input.reading);
    if (status === 'withdrawn') {
      const reason = str(input.reason);
      if (!reason) throw new LedgerError(400, 'reason is required to withdraw an item');
      const updated = ledgerDb.updateStatus(this.db, sessionId, item.seq, { status, reason, reading, now: this.nowIso() })!;
      this.changed(sessionId);
      return { id: `N${item.seq}`, status, line: renderItem(updated, this.ctx(sessionId)) };
    }
    const quote = str(input.quote);
    if (!quote) throw new LedgerError(400, 'quote is required for answered and parked');
    const after = reversal ? (item.decidedAt ?? item.createdAt) : item.createdAt;
    const match = findQuote(quote, this.userMessages(overseer.id, after), { after });
    if (!match.ok) throw new LedgerError(422, match.reason === 'ok_only' ? OK_ONLY_ERROR : quoteNotFoundAfterError(item.seq));
    // Rule 7: a go item becomes answered only on a named approval. Parking it needs no name.
    if (item.kind === 'go' && status === 'answered' && !namesGoApproval(match.quote, item.seq)) {
      throw new LedgerError(422, GO_APPROVAL_ERROR);
    }
    const updated = ledgerDb.updateStatus(this.db, sessionId, item.seq, {
      status, quote: match.quote, quoteMessageId: match.messageId, quoteAt: match.sentAt, reading, now: this.nowIso(),
    })!;
    this.changed(sessionId);
    return { id: `N${item.seq}`, status, line: renderItem(updated, this.ctx(sessionId)) };
  }

  // --- decision cards, Unit 4: triage and the card tools ----------------------------------------

  /**
   * ledger_add_from_agent: a proposed item goes to the user (status open), the agent's text word
   * for word, with the overseer's title (required: titles spec 2026-10-09, Unit 2). `note` becomes
   * the overseer's note; `blocks` says what the item holds up (the overseer knows that; the agent
   * block cannot set it).
   */
  addFromAgent(sessionId: string, caller: unknown, input: Record<string, unknown>): { id: string; status: 'open' } {
    this.assertOverseer(sessionId, caller);
    const item = this.requireItem(sessionId, input.id);
    if (item.status !== 'proposed') throw new LedgerError(409, `N${item.seq} is already ${item.status}.`, { status: item.status });
    const title = readTitle(input.title, {}, true);
    ledgerDb.markSent(this.db, sessionId, item.seq, { title, note: str(input.note), blocks: str(input.blocks), now: this.nowIso() });
    this.changed(sessionId);
    return { id: `N${item.seq}`, status: 'open' };
  }

  /**
   * ledger_decide_self: a low-level call by the overseer. With `id`, it decides a proposed item;
   * Unit 2 rule 4 limits it to items only it may decide. Without `id`, it records a new decision
   * that is already decided — the overseer's own low-level call that no agent proposed: always a
   * `decide` item (a `go` kind, a `user` source and a `thread` source are the user's), with the same card checks as
   * ledger_add, never sent to the user (`sent_at` NULL), `decided_at` now.
   */
  decideSelf(sessionId: string, caller: unknown, input: Record<string, unknown>): { id: string; status: 'decided_by_overseer'; line: string } {
    const overseer = this.assertOverseer(sessionId, caller);
    if (input.id === undefined || input.id === null || input.id === '') return this.recordOwnDecision(sessionId, overseer.id, input);
    const item = this.requireItem(sessionId, input.id);
    if (onlyUserCanDecide(item)) throw new LedgerError(422, ONLY_USER_ERROR);
    if (item.status !== 'proposed') throw new LedgerError(409, `N${item.seq} is already ${item.status}.`, { status: item.status });
    const choice = str(input.choice);
    const reason = str(input.reason);
    if (!choice || !reason) throw new LedgerError(400, 'choice and reason are required');
    const updated = ledgerDb.markDecidedByOverseer(this.db, sessionId, item.seq, { choice, reason, now: this.nowIso() })!;
    this.changed(sessionId);
    return { id: `N${item.seq}`, status: 'decided_by_overseer', line: renderOverseerDecisionLine(updated) };
  }

  /** decideSelf without `id`: a new item, created already decided. Nothing is created when a check fails. */
  private recordOwnDecision(sessionId: string, overseerId: string, input: Record<string, unknown>): { id: string; status: 'decided_by_overseer'; line: string } {
    // Rule 4: a go item and an item sourced from the user or one of the user's threads stay with the user.
    const source = input.source as Record<string, unknown> | undefined;
    if (input.kind === 'go' || (source && typeof source === 'object' && isUserSourceKind(source.kind))) throw new LedgerError(422, ONLY_USER_ERROR);
    const text = str(input.text);
    if (!text) throw new LedgerError(400, 'text is required to record a decision of your own (or pass the id of a proposed item)');
    const choice = str(input.choice);
    const reason = str(input.reason);
    if (!choice || !reason) throw new LedgerError(400, 'choice and reason are required');
    const card = this.checkCard(sessionId, overseerId, 'decide', text, input);
    const item = ledgerDb.create(this.db, {
      sessionId,
      kind: 'decide',
      text,
      author: 'overseer',
      ...card,
      mission: str(input.mission),
      status: 'decided_by_overseer',
      decidedChoice: choice,
      reason,
      now: this.nowIso(),
    });
    this.changed(sessionId);
    return { id: `N${item.seq}`, status: 'decided_by_overseer', line: renderOverseerDecisionLine(item) };
  }

  /**
   * ledger_set_title (titles spec 2026-10-09, Unit 2): set or change the title of any item of the
   * overseer's own project. A title is a label, so a change is safe; it is not logged.
   */
  setTitle(sessionId: string, caller: unknown, input: Record<string, unknown>): { id: string; title: string } {
    this.assertOverseer(sessionId, caller);
    const item = this.requireItem(sessionId, input.id);
    if (str(input.title) === undefined) throw new LedgerError(400, 'title is required');
    const title = readTitle(input.title)!;
    ledgerDb.setTitle(this.db, sessionId, item.seq, title);
    this.changed(sessionId);
    return { id: `N${item.seq}`, title };
  }

  /** ledger_mark_default: work now runs on the default of an open decision. It stays open. */
  markDefault(sessionId: string, caller: unknown, input: Record<string, unknown>): { id: string; line: string } {
    this.assertOverseer(sessionId, caller);
    const item = this.requireItem(sessionId, input.id);
    if (item.kind !== 'go' && item.kind !== 'decide') throw new LedgerError(400, 'only a go or decide item has a default');
    if (item.status !== 'open') throw new LedgerError(409, `N${item.seq} is already ${item.status}.`, { status: item.status });
    const updated = ledgerDb.markOnDefault(this.db, sessionId, item.seq, this.nowIso())!;
    this.changed(sessionId);
    return { id: `N${item.seq}`, line: renderDefaultLine(updated, { timeZone: this.timeZone }) };
  }

  /** ledger_show: the full cards of the given items, or of every open decision; `rules: true` prints the project rules ("show rules"). */
  show(sessionId: string, caller: unknown, input: Record<string, unknown>): { text: string } {
    this.assertOverseer(sessionId, caller);
    const ctx = this.ctx(sessionId);
    if (input.rules === true) return { text: renderRulesList(ledgerDb.listBySession(this.db, sessionId), ctx) };
    const render = (i: ledgerDb.LedgerItem) => (i.kind === 'go' || i.kind === 'decide' ? renderCard(i, ctx) : renderItem(i, ctx));
    if (input.all === true) {
      const open = ledgerDb.listBySession(this.db, sessionId).filter((i) => i.status === 'open' && (i.kind === 'go' || i.kind === 'decide'));
      return { text: open.length ? open.map(render).join('\n\n') : 'No open decisions.' };
    }
    const raw = typeof input.ids === 'string' ? [input.ids] : input.ids;
    if (!Array.isArray(raw) || raw.length === 0) throw new LedgerError(400, 'pass ids (e.g. ["N17"]) or all: true');
    return { text: raw.map((id) => render(this.requireItem(sessionId, id))).join('\n\n') };
  }

  note(sessionId: string, caller: unknown, input: Record<string, unknown>): { id: string; line: string } {
    const overseer = this.assertOverseer(sessionId, caller);
    const quote = str(input.quote);
    if (!quote) throw new LedgerError(400, 'quote is required');
    const match = findQuote(quote, this.userMessages(overseer.id, null), { after: null });
    if (!match.ok) throw new LedgerError(422, match.reason === 'ok_only' ? OK_ONLY_ERROR : QUOTE_NOT_FOUND_STATEMENT_ERROR);
    const item = ledgerDb.create(this.db, {
      sessionId,
      kind: 'statement',
      text: match.quote,
      author: 'you',
      mission: str(input.mission),
      status: 'answered',
      quote: match.quote,
      quoteMessageId: match.messageId,
      quoteAt: match.sentAt,
      reading: str(input.reading),
      // Unit 2 rule 5: a project rule exists only as a statement with the user's checked words.
      policy: input.policy === true,
      now: this.nowIso(),
    });
    this.changed(sessionId);
    return { id: `N${item.seq}`, line: renderItem(item, this.ctx(sessionId)) };
  }

  /**
   * The ledger part of a recap. `paste` is what the overseer pastes into the recap (pinned card spec
   * 2026-10-08, Unit 5: the new items, the decided ones, the count line); `text` is the full ledger
   * (then the open items without a title: titles spec 2026-10-09, Unit 3) and `rules` each project
   * rule in full, both for the overseer's own use (overseer memory scope spec 2026-10-07, Unit 5). Both are relative to the recap before this call. `forRecap` stamps
   * lastRecapAt and clears the interim timer.
   */
  list(sessionId: string, caller: unknown, opts: { forRecap?: boolean } = {}): { paste: string; text: string; openIds: string[]; rules: string[] } {
    const overseer = this.assertOverseer(sessionId, caller);
    let cfg: Record<string, any> = {};
    try { cfg = JSON.parse(overseer.config || '{}'); } catch { /* default {} */ }
    const lastRecapAt = typeof cfg[LAST_RECAP_KEY] === 'string' ? (cfg[LAST_RECAP_KEY] as string) : null;
    const items = ledgerDb.listBySession(this.db, sessionId);
    const paste = renderRecapPaste(items, { now: this.clock(), lastRecapAt });
    // Titles spec 2026-10-09, Unit 3: the open items without a title close the own-use text.
    const text = [renderLedgerSections(items, { now: this.clock(), lastRecapAt, timeZone: this.timeZone }), renderUntitledList(items)]
      .filter(Boolean).join('\n\n');
    if (opts.forRecap) {
      cfg[LAST_RECAP_KEY] = this.nowIso();
      delete cfg[INTERIM_DUE_KEY];
      terminalsDb.updateConfig(this.db, overseer.id, cfg);
      this.changed(sessionId); // a recap changes which items are new
    }
    const ctx = this.ctx(sessionId);
    return {
      paste,
      text,
      openIds: items.filter((i) => i.status === 'open').map((i) => `N${i.seq}`),
      rules: projectRules(items).map((i) => renderItem(i, ctx)),
    };
  }

  /**
   * The pinned card (pinned card spec 2026-10-08, Unit 2). Read-only: it never stamps lastRecapAt
   * and never clears the interim timer, so a page load is never a recap. No caller check, like the
   * routes that return conversations: the network is the gate. "New" is relative to the last recap
   * of the project's live overseer; with none, nothing has been recapped yet.
   */
  card(sessionId: string): LedgerCard {
    const session = sessionsDb.getById(this.db, sessionId);
    if (!session) throw new LedgerError(404, `Unknown project: ${sessionId}`);
    const overseer = terminalsDb.listBySession(this.db, sessionId).map(terminalsDb.rowToTerminal) // not archived
      .find((t) => t.config?.role === 'coordinator');
    const lastRecapAt = typeof overseer?.config[LAST_RECAP_KEY] === 'string' ? (overseer.config[LAST_RECAP_KEY] as string) : null;
    const items = ledgerDb.listBySession(this.db, sessionId);
    // Unit 5: git runs only for a ledger with a PR or issue source.
    const linked = items.some((i) => i.sourceKind === 'pr' || i.sourceKind === 'issue');
    const githubRepo = linked && session.working_dir ? this.githubRepo(session.working_dir) : null;
    return buildLedgerCard(items, { now: this.clock(), lastRecapAt, githubRepo });
  }

  /** One-time load of open items and earlier decisions from the overseer's context. */
  importItems(sessionId: string, caller: unknown, rawItems: unknown): { ids: string[] } {
    const overseer = this.assertOverseer(sessionId, caller);
    if (!Array.isArray(rawItems) || rawItems.length === 0) throw new LedgerError(400, 'items must be a non-empty array');
    const inputs = rawItems.map((raw, i): ledgerDb.CreateLedgerInput => {
      const it = (raw ?? {}) as Record<string, unknown>;
      const kind = it.kind;
      if (typeof kind !== 'string' || !IMPORT_KINDS.has(kind)) throw new LedgerError(400, `items[${i}].kind must be 'go', 'decide', 'do' or 'statement'`);
      const text = str(it.text);
      if (!text) throw new LedgerError(400, `items[${i}].text is required`);
      const status = it.status === undefined ? (kind === 'statement' ? 'answered' : 'open') : it.status;
      if (typeof status !== 'string' || !IMPORT_STATUSES.has(status)) throw new LedgerError(400, `items[${i}].status must be 'open', 'answered' or 'parked'`);
      // Unit 2 rule 5: an imported statement has no checked quote, so it can never be a project rule.
      if (it.policy !== undefined && it.policy !== false) {
        throw new LedgerError(400, `items[${i}].policy is not allowed: a project rule needs the user's checked words (ledger_note with policy: true)`);
      }
      // Titles spec 2026-10-09, Unit 2: an open go, decide or do item needs a title; an answered or
      // parked item and a statement may have one.
      const title = readTitle(it.title, { item: i }, kind !== 'statement' && status === 'open');
      const card = this.checkCard(sessionId, overseer.id, kind as ledgerDb.LedgerKind, text, it, { item: i });
      return {
        sessionId,
        kind: kind as ledgerDb.LedgerKind,
        text,
        title,
        author: kind === 'statement' ? 'you' : (str(it.author) ?? 'overseer'),
        ...card,
        options: optionList(it.options, `items[${i}].options`),
        blocks: str(it.blocks),
        mission: str(it.mission),
        reading: str(it.reading),
        status: (kind === 'statement' ? 'answered' : status) as ledgerDb.LedgerStatus,
        origin: 'imported',
        now: this.nowIso(),
      };
    });
    const created = this.db.transaction(() => inputs.map((input) => ledgerDb.create(this.db, input)))();
    this.changed(sessionId);
    return { ids: created.map((i) => `N${i.seq}`) };
  }

  /**
   * Unit 3: the entries of an agent's owner-decisions block become `proposed` items, in the agent's
   * own words. Each entry passes the same card checks as ledger_add (the source is the agent, with
   * `where.path` and `where.section` as the place and `id` as the source ID); an entry that fails is
   * skipped and reported by its id and the failed check. A repeat of the same id from the same agent
   * with the same question changes nothing; with a changed question, the new item supersedes the old
   * one while the old one is still proposed (after triage, it is a new item without a link).
   * Daemon-internal: no caller check.
   */
  captureAgentBlock(
    sessionId: string,
    agent: { id: string; label: string; mission: string | null },
    entries: readonly unknown[],
  ): { created: number[]; skipped: { id: string; reason: string }[] } {
    const created: number[] = [];
    const skipped: { id: string; reason: string }[] = [];
    const same = (a: string, b: string) => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();
    this.db.transaction(() => {
      entries.forEach((raw, i) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { skipped.push({ id: `#${i + 1}`, reason: 'the entry is not an object' }); return; }
        const e = raw as Record<string, unknown>;
        const id = typeof e.id === 'string' || typeof e.id === 'number' ? String(e.id).trim() : '';
        if (!id) { skipped.push({ id: `#${i + 1}`, reason: 'the entry has no id' }); return; }
        const question = str(e.question);
        if (!question) { skipped.push({ id, reason: 'the entry has no question' }); return; }
        const kind = e.kind === undefined ? 'decide' : e.kind;
        if (kind !== 'decide' && kind !== 'go') { skipped.push({ id, reason: "kind must be 'decide' or 'go'" }); return; }
        const where = (e.where && typeof e.where === 'object' ? e.where : {}) as Record<string, unknown>;
        const wherePath = str(where.path);
        const whereSection = str(where.section);
        const place = wherePath ? (whereSection ? `${wherePath}#${whereSection}` : wherePath) : (whereSection ? `#${whereSection}` : undefined);
        let card: CardFields;
        try {
          card = this.checkCard(sessionId, null, kind, question, {
            context: e.context, options: e.options, recommendation: e.recommendation, why: e.why, default: e.default,
            source: { kind: 'agent', ref: agent.id, section: place, id },
          });
        } catch (err) {
          if (err instanceof LedgerError) { skipped.push({ id, reason: err.message }); return; }
          throw err;
        }
        const previous = this.db.prepare(`SELECT seq FROM ledger_items WHERE session_id = ? AND agent_terminal_id = ? AND agent_decision_id = ?
          ORDER BY seq DESC LIMIT 1`).get(sessionId, agent.id, id) as { seq: number } | undefined;
        const old = previous ? ledgerDb.getBySeq(this.db, sessionId, previous.seq) : null;
        if (old && same(old.text, question)) return; // the same decision again: nothing changes
        const item = ledgerDb.create(this.db, {
          sessionId,
          kind,
          text: question,
          author: agent.label,
          ...card,
          sourceRef: agent.label,
          // No `blocks` from the entry: an agent must not lift its own item into the top 5. The
          // overseer sets it at triage (ledger_add_from_agent). Author, status, policy, supersedes,
          // sent_at and origin come from the daemon only.
          mission: agent.mission,
          status: 'proposed',
          agentTerminalId: agent.id,
          agentDecisionId: id,
          supersedes: old && old.status === 'proposed' ? old.seq : null,
          now: this.nowIso(),
        });
        created.push(item.seq);
      });
    })();
    if (created.length) this.changed(sessionId);
    return { created, skipped };
  }

  /** The "Owner decisions (verbatim, from the ledger)" block for an agent hand-off. */
  handoff(sessionId: string, caller: unknown, rawIds: unknown): { block: string } {
    this.assertOverseer(sessionId, caller);
    if (!Array.isArray(rawIds) || rawIds.length === 0) throw new LedgerError(400, 'ids must be a non-empty array of ledger item IDs');
    const items = rawIds.map((raw) => this.requireItem(sessionId, raw));
    return { block: renderHandoffBlock(items, this.ctx(sessionId)) };
  }
}
