import type Database from 'better-sqlite3';
import * as appState from '../db/app-state.js';
import { AGENT_TYPES, type AgentType } from '../providers/agent-types.js';

/**
 * Per-harness preferences, persisted DAEMON-side (one app_state JSON blob, the
 * routes/servers.ts pattern) — NOT web localStorage, because the daemon itself needs them
 * at spawn time: an opencode thread resolves its OpenRouter key by the configured secret
 * name on respawn after a daemon restart, when no browser is anywhere in the loop.
 *
 * Only settings that ACT today:
 *   defaultModel  every harness — preselected in the New Thread modal; for opencode it is
 *                 also the daemon-side fallback when a thread is created without a pick.
 *   defaultMode   claude-code/codex only (the two-mode harnesses) — preselected transport.
 *   keySecret     opencode only — the DOPPLER SECRET NAME holding the OpenRouter key. The
 *                 name is stored, never the key; the daemon resolves the value via
 *                 SecretsService.getSecret at env-refresh time (transcription's pattern).
 */
export interface HarnessSettings {
  defaultModel?: string;
  defaultMode?: 'cli' | 'pretty';
  keySecret?: string;
}

export type AllHarnessSettings = Partial<Record<AgentType, HarnessSettings>>;

const STATE_KEY = 'harness_settings';

/** The secret name used when the user never configured one. */
export const OPENCODE_DEFAULT_KEY_SECRET = 'OPENROUTER_API_KEY';

const pickString = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

function sanitize(raw: unknown): AllHarnessSettings {
  if (!raw || typeof raw !== 'object') return {};
  const out: AllHarnessSettings = {};
  for (const type of AGENT_TYPES) {
    const h = (raw as Record<string, unknown>)[type];
    if (!h || typeof h !== 'object') continue;
    const rec = h as Record<string, unknown>;
    const entry: HarnessSettings = {};
    const model = pickString(rec.defaultModel);
    if (model) entry.defaultModel = model;
    if (rec.defaultMode === 'cli' || rec.defaultMode === 'pretty') entry.defaultMode = rec.defaultMode;
    const secret = pickString(rec.keySecret);
    if (secret) entry.keySecret = secret;
    if (Object.keys(entry).length) out[type] = entry;
  }
  return out;
}

export function readHarnessSettings(db: Database.Database): AllHarnessSettings {
  const stored = appState.get(db, STATE_KEY);
  if (stored == null) return {};
  try { return sanitize(JSON.parse(stored)); } catch { return {}; }
}

/** Merge PATCH semantics per harness: an object merges field-wise; explicit null clears a
 *  field. Unknown harness keys and unknown fields are dropped, never stored. */
export function updateHarnessSettings(db: Database.Database, patch: unknown): AllHarnessSettings {
  const current = readHarnessSettings(db);
  if (patch && typeof patch === 'object') {
    for (const type of AGENT_TYPES) {
      const p = (patch as Record<string, unknown>)[type];
      if (p === undefined) continue;
      const merged: Record<string, unknown> = { ...(current[type] ?? {}) };
      if (p && typeof p === 'object') {
        for (const field of ['defaultModel', 'defaultMode', 'keySecret'] as const) {
          const v = (p as Record<string, unknown>)[field];
          if (v === undefined) continue;
          if (v === null) delete merged[field];
          else merged[field] = v;
        }
      }
      current[type] = merged as HarnessSettings;
    }
  }
  const clean = sanitize(current);
  appState.set(db, STATE_KEY, JSON.stringify(clean));
  return clean;
}

/** The Doppler secret name for the OpenCode/OpenRouter key. */
export function opencodeKeySecretName(db: Database.Database): string {
  return readHarnessSettings(db).opencode?.keySecret ?? OPENCODE_DEFAULT_KEY_SECRET;
}
