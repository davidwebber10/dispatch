/**
 * The per-turn status block (spec 2026-10-13 section 5): at most 2 KB, rendered after the
 * view in the first user message (never in the system prompt). Per project with activity:
 * live threads, threads that need the user, open ledger items, and the folder.
 */
import type Database from 'better-sqlite3';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import * as ledgerDb from '../db/ledger.js';
import type { EndlessStore } from './store.js';
import { formatWhen } from './recall.js';
import { byteLength } from './text.js';

export interface ProjectStatus { id: string; name: string; folder: string; live: number; needsYou: number; openItems: number; lastReport: string | null; messages: number }

export const STATUS_MAX_BYTES = 2048;

export function collectProjects(db: Database.Database, store: EndlessStore): ProjectStatus[] {
  const counts = store.projectCounts();
  return sessionsDb.list(db).map((s) => {
    const terminals = terminalsDb.listBySession(db, s.id);
    return {
      id: s.id,
      name: s.name,
      folder: s.working_dir,
      live: terminals.filter((t) => t.status === 'working').length,
      needsYou: terminals.filter((t) => t.status === 'needs_input').length,
      openItems: ledgerDb.listOpenSeqs(db, s.id).length,
      lastReport: store.lastOfKind('work', s.id)?.text ?? null,
      messages: counts[s.id] ?? 0,
    };
  });
}

export function buildStatusBlock(projects: ProjectStatus[], opts: { now: number; timeZone: string; projectId: string | null }): string {
  const head = ['<status>', `now: ${formatWhen(opts.now, opts.timeZone)}`];
  const foot = '</status>';
  const rows = projects
    .filter((p) => p.live + p.needsYou + p.openItems > 0 || p.id === opts.projectId)
    .sort((a, b) => Number(b.id === opts.projectId) - Number(a.id === opts.projectId))
    .map((p) => `- ${p.name}: ${p.live} live, ${p.needsYou} need you, ${p.openItems} open items; folder ${p.folder}`);
  const lines = [...head];
  let bytes = byteLength(head.join('\n')) + 1 + byteLength(foot);
  const reserve = byteLength(`- … ${rows.length} more projects`) + 1;
  let shown = 0;
  for (const r of rows) {
    if (bytes + byteLength(r) + 1 + reserve > STATUS_MAX_BYTES) break;
    lines.push(r);
    bytes += byteLength(r) + 1;
    shown++;
  }
  if (shown < rows.length) lines.push(`- … ${rows.length - shown} more projects`);
  if (rows.length === 0) lines.push('- no project has live threads or open items');
  lines.push(foot);
  return lines.join('\n');
}
