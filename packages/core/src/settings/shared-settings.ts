import type Database from 'better-sqlite3';
import * as appState from '../db/app-state.js';

/**
 * Two small preferences that are the SAME ON EVERY DEVICE, persisted daemon-side (one app_state
 * JSON blob each, the harness-settings pattern). Both used to live in each browser's
 * localStorage, so a phone and a Mac could disagree; the web uploads a device's old values
 * once when the daemon has none (`saved: false`), then reads and writes here.
 *
 *   Dictation (`stt_settings`)  provider, model and the Doppler SECRET NAME holding the speech-to-text
 *                               key. The name is stored, never the key: /api/transcribe resolves the
 *                               value from Doppler per request.
 *   Control Plane name (`coordinator_settings`)  the coordinator's display name. Stored as typed (the
 *                               web trims at display, and blank falls back to "Control Plane").
 */

export const STT_STATE_KEY = 'stt_settings';
export const COORDINATOR_STATE_KEY = 'coordinator_settings';

export interface DictationSettings { provider?: string; model?: string; secretName?: string }
export interface CoordinatorSettings { name?: string }

const MAX_ID = 100;
const MAX_NAME = 60;
const ID_RE = /^[\w.:/-]+$/;
const SECRET_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A provider or model id: short, no spaces. '' is allowed only for the secret name (= none chosen). */
function pickId(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t && t.length <= MAX_ID && ID_RE.test(t) ? t : undefined;
}
function pickSecret(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  if (t === '') return '';
  return t.length <= MAX_ID && SECRET_RE.test(t) ? t : undefined;
}

function sanitizeDictation(raw: unknown): DictationSettings {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const out: DictationSettings = {};
  const provider = pickId(r.provider); if (provider) out.provider = provider;
  const model = pickId(r.model); if (model) out.model = model;
  const secretName = pickSecret(r.secretName); if (secretName !== undefined) out.secretName = secretName;
  return out;
}

function sanitizeCoordinator(raw: unknown): CoordinatorSettings {
  if (!raw || typeof raw !== 'object') return {};
  const name = (raw as Record<string, unknown>).name;
  // Control characters out, length capped; inner and trailing spaces kept (the field saves as you type).
  if (typeof name !== 'string') return {};
  return { name: name.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, MAX_NAME) };
}

function readBlob<T>(db: Database.Database, key: string, clean: (raw: unknown) => T): { value: T; saved: boolean } {
  const stored = appState.get(db, key);
  if (stored == null) return { value: clean(null), saved: false };
  try { return { value: clean(JSON.parse(stored)), saved: true }; } catch { return { value: clean(null), saved: true }; }
}

/** Field-wise merge: a valid field in the patch replaces, null clears, absent or invalid keeps. */
function mergeBlob<T extends object>(db: Database.Database, key: string, clean: (raw: unknown) => T, fields: readonly string[], patch: unknown): T {
  const merged = { ...readBlob(db, key, clean).value } as Record<string, unknown>;
  if (patch && typeof patch === 'object') {
    const valid = clean(patch) as unknown as Record<string, unknown>;
    for (const f of fields) {
      const v = (patch as Record<string, unknown>)[f];
      if (v === null) delete merged[f];
      else if (valid[f] !== undefined) merged[f] = valid[f];
    }
  }
  const out = clean(merged);
  appState.set(db, key, JSON.stringify(out));
  return out;
}

export function readDictationSettings(db: Database.Database): DictationSettings & { saved: boolean } {
  const { value, saved } = readBlob(db, STT_STATE_KEY, sanitizeDictation);
  return { ...value, saved };
}

export function updateDictationSettings(db: Database.Database, patch: unknown): DictationSettings & { saved: true } {
  return { ...mergeBlob(db, STT_STATE_KEY, sanitizeDictation, ['provider', 'model', 'secretName'], patch), saved: true };
}

export function readCoordinatorSettings(db: Database.Database): CoordinatorSettings & { saved: boolean } {
  const { value, saved } = readBlob(db, COORDINATOR_STATE_KEY, sanitizeCoordinator);
  return { ...value, saved };
}

export function updateCoordinatorSettings(db: Database.Database, patch: unknown): CoordinatorSettings & { saved: true } {
  return { ...mergeBlob(db, COORDINATOR_STATE_KEY, sanitizeCoordinator, ['name'], patch), saved: true };
}
