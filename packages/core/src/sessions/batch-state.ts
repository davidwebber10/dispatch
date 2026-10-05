/**
 * Settle facts for agent notices (structured-recap spec, Unit 4). A batch is SETTLED when none of
 * the overseer's agents is working or queued; the Batch line on every agent notice says which.
 */
import type Database from 'better-sqlite3';
import * as terminalsDb from '../db/terminals.js';

/** The five agent notices that carry the Batch line. */
export type NoticeKind = 'finished' | 'blocked' | 'question' | 'stopped' | 'direct-message';

export interface AgentRef { id: string; label: string }

export interface BatchState {
  /** working without a pending question, scheduled, or just started (justStarted). */
  working: AgentRef[];
  queued: AgentRef[];
  /** needs_input, or working with a question pending to the overseer. */
  waiting: AgentRef[];
}

export interface BatchOptions {
  /** Agents to leave out (the notice's own subject). */
  exclude?: readonly string[];
  /** Agents that count as working whatever their status reads (dependents promoted this instant). */
  justStarted?: readonly string[];
}

/**
 * Sort the project's agents (`config.role === 'agent'`, not archived, not a scheduled role run)
 * into working / queued / waiting on the overseer. `hasPending` says whether a terminal has a
 * pending question (the structured manager's getPending).
 */
export function computeBatchState(
  db: Database.Database,
  sessionId: string,
  opts: BatchOptions,
  hasPending: (terminalId: string) => boolean,
): BatchState {
  const exclude = new Set(opts.exclude ?? []);
  const justStarted = new Set(opts.justStarted ?? []);
  const state: BatchState = { working: [], queued: [], waiting: [] };
  for (const row of terminalsDb.listBySession(db, sessionId)) {
    if (exclude.has(row.id)) continue;
    let cfg: Record<string, any> = {};
    try { cfg = JSON.parse(row.config || '{}'); } catch { /* default {} */ }
    if (cfg.role !== 'agent') continue;
    if (typeof cfg.roleRun === 'string' && cfg.roleRun) continue;
    const ref = { id: row.id, label: row.label || 'agent' };
    if (justStarted.has(row.id)) { state.working.push(ref); continue; }
    switch (row.status) {
      case 'working': (hasPending(row.id) ? state.waiting : state.working).push(ref); break;
      case 'scheduled': state.working.push(ref); break;
      case 'queued': state.queued.push(ref); break;
      case 'needs_input': state.waiting.push(ref); break;
      default: break; // waiting (idle/done), error: not part of the running batch
    }
  }
  return state;
}

/** Busy = an agent still works or is queued. Agents waiting on the overseer do not keep a batch busy. */
export function isBusy(state: BatchState): boolean {
  return state.working.length + state.queued.length > 0;
}

const agents = (n: number) => `${n} agent${n === 1 ? '' : 's'}`;
const labels = (refs: AgentRef[]) => refs.map((r) => `"${r.label}"`).join(', ');

/** The Batch line block appended (after a blank line) to every agent notice. Texts from the spec, verbatim. */
export function formatBatchFooter(state: BatchState, openSeqs: readonly number[]): string {
  const open = `Open ledger items: ${openSeqs.length ? openSeqs.map((s) => `N${s}`).join(', ') : 'none'}.`;
  const waiting = state.waiting.length ? `${agents(state.waiting.length)} waiting on you (${labels(state.waiting)})` : '';
  if (isBusy(state)) {
    const parts: string[] = [];
    if (state.working.length) parts.push(`${agents(state.working.length)} (${labels(state.working)})`);
    if (state.queued.length) parts.push(`${state.queued.length} queued`);
    if (waiting) parts.push(waiting);
    return [
      `Batch: still working — ${parts.join('; ')}.`,
      'Do not post a recap. If this needs a decision, add it with ledger_add',
      'and post only that item. Otherwise write at most one line.',
      open,
    ].join('\n');
  }
  return [
    'Batch: no other agent is working or queued.',
    ...(waiting ? [`Still ${waiting}.`] : []),
    'If you start a next step now, write at most one line.',
    'If you start nothing, the batch has settled: post the recap now',
    '(ledger_list with forRecap, and list_agents).',
    open,
  ].join('\n');
}
