import type Database from 'better-sqlite3';
import * as appState from '../db/app-state.js';
import { getRunningVersion } from '../update/version.js';
import { detectWsl } from '../platform/wsl.js';
import { buildReport, utcDay, type TelemetryReport } from './payload.js';

export const TELEMETRY_URL = 'https://dispatchd.app/v1/ping';
const RESEND_MS = 6 * 3_600_000;
const TIMEOUT_MS = 5_000;

export interface TelemetryDeps {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  version?: string;
  platform?: TelemetryReport['platform'];
  url?: string;
  bootDelayMs?: number;
  intervalMs?: number;
}

export function telemetryEnabled(db: Database.Database, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.DISPATCH_TELEMETRY === '0') return false;
  return appState.get(db, 'telemetry_enabled') !== '0';
}

/**
 * Turning the switch off forgets what was sent and when this install was alive, so no
 * later report carries a day from the off period. Turning it on again (from off) starts a
 * new window at `at`: usage before that moment is never sent.
 */
export function setTelemetryEnabled(db: Database.Database, on: boolean, at: Date = new Date()): void {
  const wasOff = appState.get(db, 'telemetry_enabled') === '0';
  if (!on) {
    for (const k of ['telemetry_alive_day', 'telemetry_last_sent_day', 'telemetry_last_sent_at']) appState.set(db, k, '');
  } else if (wasOff) {
    appState.set(db, 'telemetry_since', at.toISOString());
  }
  appState.set(db, 'telemetry_enabled', on ? '1' : '0');
}

function hostPlatform(): TelemetryReport['platform'] {
  if (process.platform === 'darwin') return 'darwin';
  return detectWsl() ? 'wsl' : 'linux';
}

let warnedDay = '';

/** One check. Never throws. */
export async function checkTelemetryOnce(db: Database.Database, d: TelemetryDeps = {}): Promise<'sent' | 'skipped' | 'disabled' | 'failed'> {
  try {
    const env = d.env ?? process.env;
    if (!telemetryEnabled(db, env)) return 'disabled';
    const now = (d.now ?? (() => new Date()))();
    const today = utcDay(now);
    const yesterday = utcDay(new Date(now.getTime() - 86_400_000));
    const aliveBefore = appState.get(db, 'telemetry_alive_day');
    appState.set(db, 'telemetry_alive_day', today);
    const lastSentAt = Number(appState.get(db, 'telemetry_last_sent_at') ?? 0);
    const lastSentDay = appState.get(db, 'telemetry_last_sent_day');
    const newDay = lastSentDay !== today;
    if (!newDay && now.getTime() - lastSentAt < RESEND_MS) return 'skipped';
    // Yesterday rides along only when this install was alive yesterday and its final totals are not yet sent.
    const includeYesterday = (aliveBefore === yesterday || lastSentDay === yesterday) && newDay;
    const since = appState.get(db, 'telemetry_since') || undefined;
    const report = buildReport(db, { now, version: d.version ?? getRunningVersion(), platform: d.platform ?? hostPlatform(), includeYesterday, since });
    const res = await (d.fetchImpl ?? fetch)(d.url ?? env.DISPATCH_TELEMETRY_URL ?? TELEMETRY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(report),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    appState.set(db, 'telemetry_last_sent_at', String(now.getTime()));
    appState.set(db, 'telemetry_last_sent_day', today);
    return 'sent';
  } catch (err) {
    const day = new Date().toISOString().slice(0, 10);
    if (warnedDay !== day) { warnedDay = day; console.warn('[telemetry] send failed:', err instanceof Error ? err.message : String(err)); }
    return 'failed';
  }
}

export function startTelemetryLoop(db: Database.Database, d: TelemetryDeps = {}): { stop(): void } {
  let interval: NodeJS.Timeout | null = null;
  const boot = setTimeout(() => {
    void checkTelemetryOnce(db, d);
    interval = setInterval(() => { void checkTelemetryOnce(db, d); }, d.intervalMs ?? 3_600_000);
  }, d.bootDelayMs ?? 60_000);
  return { stop: () => { clearTimeout(boot); if (interval) clearInterval(interval); } };
}
