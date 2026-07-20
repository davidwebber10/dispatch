// Pure mapper: which of the four board columns a thread belongs on right now, plus the small
// amount of derived presentation data (`BoardCardModel`) useBoardData.ts folds every project's
// terminals through. No React, no store, no I/O — see
// docs/superpowers/specs/2026-07-20-thread-board-design.md for the model this implements.

import type { Terminal, TerminalLastOutcome, TerminalBoardState } from '../../api/types';
import type { ThreadStatus as LiveStatus } from '../../stores/threadStatus';

export type { LiveStatus };

export type BoardColumn = 'needs_help' | 'complete' | 'working' | 'resting';

export interface BoardCardModel {
  terminalId: string;
  projectId: string;
  projectName: string;
  label: string;
  column: BoardColumn;
  detail: string;              // the line under the title
  inferred: boolean;           // an inferred ask renders dimmer with a ~ marker
  pending: boolean;            // Working sub-tier: queued/scheduled/blocked rather than live
  overridden: boolean;
}

// 'working' is deliberately excluded: it is an observed fact, not a judgement the human can
// assert, so the server rejects it as an override target (400 — see POST /terminals/:id/board)
// and a row should never legitimately carry it here either.
type OverrideTarget = Exclude<BoardColumn, 'working'>;
const OVERRIDE_TARGETS: readonly OverrideTarget[] = ['needs_help', 'complete', 'resting'];
function isOverrideTarget(v: unknown): v is OverrideTarget {
  return typeof v === 'string' && (OVERRIDE_TARGETS as readonly string[]).includes(v);
}

/**
 * Parses `terminal.config.lastOutcome`, tolerating an absent or malformed blob exactly like the
 * server does — `config` is opaque best-effort JSON, not a schema. Returns null when there's no
 * genuine outcome object, which is itself meaningful: a terminal that never finished a turn.
 */
export function readLastOutcome(t: Terminal): TerminalLastOutcome | null {
  const raw = (t.config as Record<string, unknown> | undefined)?.lastOutcome;
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.summary !== 'string') return null;
  return {
    summary: o.summary,
    needsHelp: o.needsHelp === true,
    inferred: o.inferred === true,
    at: typeof o.at === 'string' ? o.at : '',
  };
}

/**
 * Parses `terminal.config.boardState`. Absent on every row until the human acts on it (or on
 * every row today, since the concurrent core task that writes it lands separately) — that
 * absence must behave as "not acknowledged, no override", never as an error.
 */
export function readBoardState(t: Terminal): TerminalBoardState {
  const raw = (t.config as Record<string, unknown> | undefined)?.boardState;
  if (!raw || typeof raw !== 'object') return {};
  const o = raw as Record<string, unknown>;
  return {
    acknowledgedAt: typeof o.acknowledgedAt === 'string' ? o.acknowledgedAt : undefined,
    override: isOverrideTarget(o.override) ? o.override : null,
  };
}

/**
 * Which of the four columns a thread belongs on right now — the single source of truth for
 * "will this move without me?" Decision order mirrors the spec's decision tree exactly:
 *
 *   1. A manual override always wins — it's the escape hatch for a mis-derived status, and
 *      stays in force until the thread shows real activity (cleared server-side; the client
 *      just honours whatever the row currently says).
 *   2. Archived threads are Resting no matter how their last turn ended. In practice the
 *      terminal list the board reads from (`listTerminals`) already excludes archived rows, so
 *      this mostly guards a defensive/direct call to this function rather than driving the
 *      board's normal filtering.
 *   3. Live status (WS-fresh, may be ahead of the persisted row) beats the persisted row:
 *      needs_input/error → Needs Help (stopped, and stopped BECAUSE it needs you); working,
 *      or the queued/scheduled waiting sub-tier → Working (proceeds without you either way).
 *   4. Otherwise nothing is currently in flight. Complete vs. Resting is decided purely by the
 *      last outcome + whether it's been acknowledged — never by recency. No outcome at all
 *      means no evidence the thread ever finished a turn, so it rests rather than completes.
 */
export function boardColumn(t: Terminal, s?: LiveStatus): BoardColumn {
  const board = readBoardState(t);
  if (board.override) return board.override;

  if (t.archivedAt) return 'resting';

  const liveThreadStatus = s?.threadStatus;
  const coarse = s?.status ?? t.status;

  // A thread stopped because it needs you — the exact membrane escalation (needs_input) or an
  // error, which equally will not move again without you looking at it.
  if (liveThreadStatus === 'needs_input' || liveThreadStatus === 'error' || coarse === 'needs_input' || coarse === 'error') {
    return 'needs_help';
  }
  // A thread that will act again WITHOUT you — live (working/starting) or the waiting sub-tier
  // (queued/scheduled). Both proceed on their own, which is the definition of Working.
  if (liveThreadStatus === 'working' || liveThreadStatus === 'starting' || coarse === 'working' || coarse === 'queued' || coarse === 'scheduled') {
    return 'working';
  }

  const outcome = readLastOutcome(t);
  if (!outcome) return 'resting'; // never ran a turn — no evidence of finishing
  // Belt-and-suspenders: an outcome recorded as an ask always needs you, even if the persisted
  // status row lags behind it for a moment.
  if (outcome.needsHelp) return 'needs_help';
  return board.acknowledgedAt ? 'resting' : 'complete';
}

/** True while a Working card is in the waiting sub-tier (queued/scheduled) rather than actually
 * live right now — dashed/dimmed treatment per the spec's "Waiting is a sub-type of Working". */
function isPending(t: Terminal, s?: LiveStatus): boolean {
  if (s?.threadStatus === 'working' || s?.threadStatus === 'starting') return false;
  const coarse = s?.status ?? t.status;
  return coarse === 'queued' || coarse === 'scheduled';
}

/** The detail line under a card's title, per column. Plain descriptive text — any icon/glyph
 * treatment (●/◌) is the card component's presentational job, driven off `column`/`pending`. */
function detailFor(column: BoardColumn, outcome: TerminalLastOutcome | null, s: LiveStatus | undefined, pending: boolean): string {
  switch (column) {
    case 'needs_help':
      // The persisted outcome carries the REAL question text (declared `ask`, or the inferred
      // heuristic's matched closing text) — prefer it over the live activity label, which for
      // an inferred ask is just the generic 'Asked a question' (see server.ts's markNeedsInput
      // call), not the actual question.
      if (outcome?.needsHelp && outcome.summary.trim()) return outcome.summary.trim();
      return s?.activity?.trim() || 'Needs your input';
    case 'complete':
      return outcome?.summary?.trim() || 'Finished';
    case 'working':
      if (s?.activity?.trim()) return s.activity.trim();
      return pending ? 'Queued — resumes on its own' : 'Running';
    case 'resting':
      return outcome?.summary?.trim() || 'new — no work yet';
  }
}

/** Map one terminal (+ its live status, if any) into a full board card model. */
export function toBoardCard(t: Terminal, projectId: string, projectName: string, s?: LiveStatus): BoardCardModel {
  const board = readBoardState(t);
  const outcome = readLastOutcome(t);
  const column = boardColumn(t, s);
  const pending = column === 'working' && isPending(t, s);
  const overridden = board.override != null;
  // Only a genuine needs_help card whose outcome was RECORDED as inferred (the heuristic
  // guessed, nothing was declared) gets the dimmer "~" treatment — never an override (that's a
  // deliberate human judgement, not a guess).
  const inferred = column === 'needs_help' && !overridden && !!outcome?.needsHelp && !!outcome?.inferred;
  return {
    terminalId: t.id,
    projectId,
    projectName,
    label: t.label,
    column,
    detail: detailFor(column, outcome, s, pending),
    inferred,
    pending,
    overridden,
  };
}
