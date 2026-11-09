// packages/core/src/structured/shared/settle-turn.ts
//
// The turn boundary that the Codex and the ACP manager each had a copy of: what a manager emits
// when a turn ends, from what the agent declared (report_status) and what the translator saw.
//
// The precedence:
//   1. declared `needs_you`          → 'needs-help', inferred: false
//   2. any other declaration         → 'idle', declared: true, state: 'done' | 'blocked' (a declared
//      `blocked` still settles idle: a thread that waits on another agent does not need the human;
//      `state` and `blocker` keep WHICH one it was for SessionService.noteTurnOutcome)
//   3. no declaration, and the translator's text check found a closing question
//                                    → 'needs-help', inferred: true
//   4. otherwise                     → 'idle', declared: false
//
// `summary` is the manager's own text for the turn's outcome (the completed agent message that
// the Codex and ACP translators stash). It rides every 'idle' so a card has a real outcome line.
//
// The Claude manager calls this for the same chain, with two differences that stay in its `result`
// handler (manager.ts):
//   - A usage limit, an error result and a wake tool (ScheduleWakeup, CronCreate) are decided
//     there first. A wake sits between rule 1 and rule 2: a declared `needs_you` wins over it, and
//     it wins over a declared `done` or `blocked`.
//   - Claude has no stashed summary: it reads the closing text from the ring to decide rule 3, and
//     its 'idle' detail has no `summary` key (`withSummary: false`). The listener reads the ring.

import type { StatusDeclaration } from '../manager.js';
import type { IdleDetail, NeedsHelpDetail } from './events.js';

export interface SettleSession {
  terminalId: string;
  /** The agent's report_status declaration for the current turn. Read once here, then cleared. */
  declared?: StatusDeclaration;
  /** The id of the last turn that settled (set here), for the once-per-turn rule. */
  settledTurnId?: string | number;
}

export type SettleAction =
  | { kind: 'idle'; summary?: string; turnId?: string | number }
  | { kind: 'needs-help'; ask: string; summary: string; turnId?: string | number };

export interface SettleDeps {
  emit(event: 'idle', terminalId: string, detail: IdleDetail): void;
  emit(event: 'needs-help', terminalId: string, detail: NeedsHelpDetail): void;
  /** True when an 'idle' detail carries the action's `summary` (Codex, ACP). False for Claude. */
  withSummary: boolean;
}

/**
 * Settle one turn. A harness that names its turns passes the id as `action.turnId`: a second
 * settle with the id of the turn that settled last is ignored (and leaves the declaration for the
 * turn it belongs to). With no `turnId` every call settles.
 */
export function settleTurn(session: SettleSession, action: SettleAction, deps: SettleDeps): void {
  if (action.turnId !== undefined) {
    if (session.settledTurnId === action.turnId) return;
    session.settledTurnId = action.turnId;
  }
  const declared = session.declared;
  session.declared = undefined; // a declaration is for one turn: it must not reach the next one
  if (declared?.state === 'needs_you') {
    deps.emit('needs-help', session.terminalId, { ask: declared.ask ?? declared.summary, summary: declared.summary, inferred: false });
    return;
  }
  if (declared) {
    const detail: IdleDetail = { declared: true, state: declared.state as 'done' | 'blocked' };
    if (deps.withSummary) detail.summary = action.summary;
    if (declared.state === 'blocked' && declared.blocker) detail.blocker = declared.blocker;
    deps.emit('idle', session.terminalId, detail);
    return;
  }
  if (action.kind === 'needs-help') {
    deps.emit('needs-help', session.terminalId, { ask: action.ask, summary: action.summary, inferred: true });
    return;
  }
  const detail: IdleDetail = { declared: false };
  if (deps.withSummary) detail.summary = action.summary;
  deps.emit('idle', session.terminalId, detail);
}
