/**
 * The Chat pane's thread rows (spec 2026-10-19 sections 3.2, 3.3, 3.5). Only threads with recent
 * activity: active ones of any age, finished ones of today. The model's status block does not
 * use this; it stays on collectProjects.
 */
import type Database from 'better-sqlite3';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import { isAgentType } from '../providers/agent-types.js';

export type PaneState = 'working' | 'needs_you' | 'queued' | 'error' | 'done' | 'idle';
export type StartedBy = 'chat' | 'overseer' | 'thread' | 'role' | 'user';
export interface PaneThread {
  id: string; project: string; label: string; harness: string; state: PaneState;
  startedBy: StartedBy; via: string | null; startedAt: string; lastActivityAt: string | null; question: string | null;
}

export const PANE_MAX_THREADS = 60;
export const QUESTION_MAX_CHARS = 280;
const RANK: Record<PaneState, number> = { needs_you: 0, working: 1, queued: 2, error: 3, done: 4, idle: 4 };

type Cfg = Record<string, unknown>;
const cfgOf = (raw: string | null): Cfg => {
  try { const c = JSON.parse(raw || '{}'); return c && typeof c === 'object' ? c : {}; } catch { return {}; }
};
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Local midnight of `now` in `timeZone`, as epoch ms (DST days may be off by the shift; accepted). */
export function startOfLocalDay(now: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(now));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return now - ((n('hour') * 60 + n('minute')) * 60 + n('second')) * 1000 - (now % 1000);
}

export function paneState(status: string, cfg: Cfg): PaneState {
  switch (status) {
    case 'working': return 'working';
    case 'needs_input': return 'needs_you';
    case 'queued': return 'queued';
    case 'error': return 'error';
    default: return cfg.role === 'agent' || cfg.origin === 'endless' ? 'done' : 'idle';
  }
}

export function startedByOf(cfg: Cfg, parent: (id: string) => { label: string; cfg: Cfg } | null): { startedBy: StartedBy; via: string | null } {
  if (cfg.origin === 'endless') return { startedBy: 'chat', via: null };
  if (str(cfg.roleRun)) return { startedBy: 'role', via: null };
  if (cfg.role !== 'agent') return { startedBy: 'user', via: null };
  const by = str(cfg.spawnedBy);
  if (!by) return { startedBy: 'overseer', via: null }; // rows from before spawnedBy existed
  const p = parent(by);
  if (!p) return { startedBy: 'thread', via: null };
  if (p.cfg.role === 'coordinator') return { startedBy: 'overseer', via: null };
  if (p.cfg.origin === 'endless') return { startedBy: 'chat', via: p.label };
  return { startedBy: 'thread', via: p.label };
}

export function collectPaneThreads(db: Database.Database, opts: { now: number; timeZone: string; question: (id: string) => string }): { threads: PaneThread[]; truncated: boolean } {
  const midnight = startOfLocalDay(opts.now, opts.timeZone);
  const parent = (id: string) => {
    const r = terminalsDb.getById(db, id);
    return r ? { label: r.label, cfg: cfgOf(r.config) } : null;
  };
  const rows: PaneThread[] = [];
  for (const s of sessionsDb.list(db)) {
    for (const t of terminalsDb.listBySession(db, s.id)) {
      if (!isAgentType(t.type)) continue;
      const cfg = cfgOf(t.config);
      if (cfg.role === 'coordinator') continue;
      const state = paneState(t.status, cfg);
      const last = t.last_activity_at ? Date.parse(t.last_activity_at) : NaN;
      if ((state === 'done' || state === 'idle') && !(last >= midnight)) continue;
      let question: string | null = null;
      if (state === 'needs_you') {
        try { question = opts.question(t.id).trim().slice(0, QUESTION_MAX_CHARS) || null; } catch { question = null; }
      }
      rows.push({ id: t.id, project: s.id, label: t.label, harness: t.type, state, ...startedByOf(cfg, parent), startedAt: t.created_at, lastActivityAt: t.last_activity_at, question });
    }
  }
  const at = (r: PaneThread) => (r.lastActivityAt ? Date.parse(r.lastActivityAt) : 0);
  rows.sort((a, b) => RANK[a.state] - RANK[b.state] || at(b) - at(a));
  return { threads: rows.slice(0, PANE_MAX_THREADS), truncated: rows.length > PANE_MAX_THREADS };
}
