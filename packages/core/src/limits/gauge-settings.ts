// packages/core/src/limits/gauge-settings.ts
// The usage gauge's daemon-wide settings: the warning threshold and the push switch (#127).
// Daemon-wide because the daemon sends the push, and the amber chip must agree with it.
import type Database from 'better-sqlite3';
import * as appState from '../db/app-state.js';

export interface UsageLimitSettings {
  /** Percent at which a counted window turns the chip amber and sends one push. Integer 50 to 99. */
  warnPercent: number;
  /** Send one web push when a window crosses `warnPercent`. */
  pushOnWarn: boolean;
}

export const KEY = 'usage_limit_settings';
export const WARN_MIN = 50;
export const WARN_MAX = 99;
export const DEFAULTS: UsageLimitSettings = { warnPercent: 80, pushOnWarn: true };

/** A finite number, rounded then clamped to 50..99. Anything else is null (the route answers 400). */
export function sanitizeWarn(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.min(WARN_MAX, Math.max(WARN_MIN, Math.round(v)));
}

/** A stored blob read back: each field falls back to its default when missing or invalid. */
export function sanitize(raw: unknown): UsageLimitSettings {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    warnPercent: sanitizeWarn(o.warnPercent) ?? DEFAULTS.warnPercent,
    pushOnWarn: typeof o.pushOnWarn === 'boolean' ? o.pushOnWarn : DEFAULTS.pushOnWarn,
  };
}

export function get(db: Database.Database): UsageLimitSettings {
  try { return sanitize(JSON.parse(appState.get(db, KEY) ?? '{}')); } catch { return { ...DEFAULTS }; }
}

/** A patch the route has already validated. Returns the stored result. */
export function set(db: Database.Database, patch: Partial<UsageLimitSettings>): UsageLimitSettings {
  const next = sanitize({ ...get(db), ...patch });
  appState.set(db, KEY, JSON.stringify(next));
  return next;
}
