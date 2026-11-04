/**
 * Who hears a worker's notices (finished a turn, needs help, a pending question, stopped, the user
 * messaged it, the user answered its question).
 *
 * The thread that started the worker (`config.spawnedBy`) hears them. A worker the overseer
 * started reports to the overseer; a worker any other thread started reports to that thread. A
 * thread Chat started, and any child of one at any depth, reports to Chat (Chat has its own path).
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

const MAX_HOPS = 8; // a chain is at most 4 deep; the cap only guards a cycle in bad data

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
  const starterCfg = cfgOf(starter.config);
  if (starterCfg.role === 'coordinator') return { to: 'overseer' };
  // Any ancestor Chat started puts the whole chain under Chat (rows made before the origin went down).
  const seen = new Set<string>([starterId]);
  let cur: Record<string, any> = starterCfg;
  for (let i = 0; i < MAX_HOPS; i++) {
    if (cur.origin === 'endless') return { to: 'chat' };
    const up = typeof cur.spawnedBy === 'string' ? cur.spawnedBy : '';
    if (!up || seen.has(up)) break;
    seen.add(up);
    const row = terminalsDb.getById(db, up);
    if (!row) break;
    cur = cfgOf(row.config);
  }
  return { to: 'starter', starterId };
}
