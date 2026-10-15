import type Database from 'better-sqlite3';
import { getInstallId } from './install-id.js';

export const PROVIDER_KEYS = ['claude', 'codex', 'opencode', 'grok', 'other'] as const;
export type ProviderKey = (typeof PROVIDER_KEYS)[number];
export interface ProviderTotals { turns: number; input: number; output: number; cacheRead: number; cacheWrite: number }
export interface DayTotals { day: string; providers: Partial<Record<ProviderKey, ProviderTotals>>; threads: number; chatTurns: number }
export interface TelemetryReport { v: 1; installId: string; version: string; platform: 'darwin' | 'wsl' | 'linux'; days: DayTotals[]; projects: number }

export const utcDay = (d: Date): string => d.toISOString().slice(0, 10);

/** `claude-code` → `claude`; anything unknown → `other`. Free text never leaves the machine. */
function providerKey(raw: string): ProviderKey {
  const p = raw.toLowerCase();
  if (p.startsWith('claude')) return 'claude';
  if (p.startsWith('codex')) return 'codex';
  if (p.startsWith('opencode')) return 'opencode';
  if (p.startsWith('grok')) return 'grok';
  return 'other';
}

function dayTotals(db: Database.Database, day: string): DayTotals {
  const from = `${day}T00:00:00.000Z`;
  const next = new Date(Date.parse(from) + 86_400_000).toISOString();
  const rows = db.prepare(`
    SELECT provider, COUNT(*) AS turns, SUM(input_tokens) AS input, SUM(output_tokens) AS output,
           SUM(cache_read_tokens) AS cacheRead, SUM(cache_create_tokens) AS cacheWrite
    FROM usage_turns WHERE started_at >= ? AND started_at < ? GROUP BY provider`).all(from, next) as
    { provider: string; turns: number; input: number; output: number; cacheRead: number; cacheWrite: number }[];
  const providers: DayTotals['providers'] = {};
  for (const r of rows) {
    const k = providerKey(r.provider);
    const t = providers[k] ?? { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    t.turns += r.turns; t.input += r.input ?? 0; t.output += r.output ?? 0; t.cacheRead += r.cacheRead ?? 0; t.cacheWrite += r.cacheWrite ?? 0;
    providers[k] = t;
  }
  const threads = (db.prepare('SELECT COUNT(DISTINCT terminal_id) AS n FROM usage_turns WHERE started_at >= ? AND started_at < ?').get(from, next) as { n: number }).n;
  const chatTurns = (db.prepare("SELECT COUNT(*) AS n FROM endless_messages WHERE kind = 'user' AND created_at >= ? AND created_at < ?")
    .get(Date.parse(from), Date.parse(next)) as { n: number }).n;
  return { day, providers, threads, chatTurns };
}

export function buildReport(db: Database.Database, o: { now: Date; version: string; platform: TelemetryReport['platform']; includeYesterday: boolean }): TelemetryReport {
  const today = utcDay(o.now);
  const days = [today];
  if (o.includeYesterday) days.unshift(utcDay(new Date(o.now.getTime() - 86_400_000)));
  const projects = (db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n;
  return { v: 1, installId: getInstallId(db), version: o.version, platform: o.platform, days: days.map((d) => dayTotals(db, d)), projects };
}
