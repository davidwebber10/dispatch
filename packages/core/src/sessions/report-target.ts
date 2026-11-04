/**
 * Who hears a worker's notices (finished a turn, needs help, a pending question, stopped, the user
 * messaged it, the user answered its question).
 *
 * The thread that started the worker (`config.spawnedBy`) hears them. A worker the overseer
 * started reports to the overseer; a worker any other thread started reports to that thread. A
 * thread Chat started reports to Chat (Chat has its own path). Chat only hears a thread whose own
 * row carries `origin: endless`, which a thread key now passes down to every child, so a child of
 * a Chat thread reports to Chat at any depth. A child made before that change has no origin: it
 * reports to its starter, like any other thread.
 * A worker with no `spawnedBy` is an old row from before the field existed: it reports to the
 * overseer, as it always did. A scheduled role run reports to its own log.
 */
import type Database from 'better-sqlite3';
import * as terminalsDb from '../db/terminals.js';

export type ReportTarget =
  | { to: 'overseer' }
  | { to: 'starter'; starterId: string }
  | { to: 'chat' }
  | { to: 'none' };

function cfgOf(raw: string | null | undefined): Record<string, any> {
  try { return JSON.parse(raw || '{}') ?? {}; } catch { return {}; }
}

/** Resolve who hears the notices of the worker whose config is `cfg`. */
export function resolveReportTarget(db: Database.Database, cfg: Record<string, any>): ReportTarget {
  if (cfg.role !== 'agent') return { to: 'none' }; // coordinators and plain threads report to the human
  if (typeof cfg.roleRun === 'string' && cfg.roleRun) return { to: 'none' };
  if (cfg.origin === 'endless') return { to: 'chat' };
  const starterId = typeof cfg.spawnedBy === 'string' ? cfg.spawnedBy : '';
  if (!starterId) return { to: 'overseer' };
  const starter = terminalsDb.getById(db, starterId);
  if (!starter) return { to: 'starter', starterId }; // gone: the caller drops the notice
  if (cfgOf(starter.config).role === 'coordinator') return { to: 'overseer' };
  return { to: 'starter', starterId };
}
