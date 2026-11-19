import type Database from 'better-sqlite3';
import * as appState from '../db/app-state.js';
import { isHostedBox } from '../os/hosted-mode.js';

/**
 * Memory settings (spec 2026-11-17-memory-design.md, section 5.3): one `memory_settings` JSON blob in
 * app_state, the shared-settings pattern. Field-wise merge: a valid field replaces, null clears
 * (back to the default), absent or invalid keeps.
 *
 *   enabled     Memory on or off. Off: no block, no memory tools, and no background reading of
 *               conversations or of Claude Code's memory. Default OFF (owner, 2026-11-19): the person
 *               turns it on in Settings > Memory. A stored value wins.
 *   paused      Threads still read memory; nothing new is saved. Default off.
 *   blockChars  Size cap of the injected text (the pointer and the pinned titles). Default 1,000, at most
 *               2,000, at least 500.
 *   projectsOff Session ids of the projects whose own scope is off ("Remember this project" off).
 *   providers   "Dispatch reads this provider" per harness provider (claude, codex, grok). A missing key
 *               means the default: on for a local install, off on a hosted box. Separate from the
 *               harness's own memory switch, which Dispatch only shows.
 */
export const MEMORY_SETTINGS_KEY = 'memory_settings';
export const DEFAULT_BLOCK_CHARS = 1000;
export const MAX_BLOCK_CHARS = 2000;
export const MIN_BLOCK_CHARS = 500;
const READABLE = ['claude', 'codex', 'grok'] as const;

export interface MemorySettings { enabled: boolean; paused: boolean; blockChars: number; projectsOff: string[]; providers: Record<string, boolean> }

const DEFAULTS: Omit<MemorySettings, 'providers'> = { enabled: false, paused: false, blockChars: DEFAULT_BLOCK_CHARS, projectsOff: [] };
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function clean(raw: unknown): Partial<MemorySettings> {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const out: Partial<MemorySettings> = {};
  if (typeof r.enabled === 'boolean') out.enabled = r.enabled;
  if (typeof r.paused === 'boolean') out.paused = r.paused;
  if (typeof r.blockChars === 'number' && Number.isFinite(r.blockChars)) {
    out.blockChars = Math.round(Math.min(MAX_BLOCK_CHARS, Math.max(MIN_BLOCK_CHARS, r.blockChars)));
  }
  if (r.providers && typeof r.providers === 'object' && !Array.isArray(r.providers)) {
    const p: Record<string, boolean> = {};
    for (const id of READABLE) { const v = (r.providers as Record<string, unknown>)[id]; if (typeof v === 'boolean') p[id] = v; }
    out.providers = p;
  }
  if (Array.isArray(r.projectsOff)) out.projectsOff = [...new Set(r.projectsOff.filter((v): v is string => typeof v === 'string' && ID_RE.test(v)))].slice(0, 1000);
  return out;
}

function stored(db: Database.Database): Partial<MemorySettings> {
  const raw = appState.get(db, MEMORY_SETTINGS_KEY);
  if (raw == null) return {};
  try { return clean(JSON.parse(raw)); } catch { return {}; }
}

export function readMemorySettings(db: Database.Database): MemorySettings {
  const s = stored(db);
  const dflt = !isHostedBox(); // the mirror of harness memory is off by default on a hosted box
  const providers = Object.fromEntries(READABLE.map((id) => [id, s.providers?.[id] ?? dflt]));
  return { ...DEFAULTS, ...s, providers };
}

const FIELDS = ['enabled', 'paused', 'blockChars', 'projectsOff'] as const;

export function updateMemorySettings(db: Database.Database, patch: unknown): MemorySettings {
  const merged: Record<string, unknown> = { ...stored(db) };
  if (patch && typeof patch === 'object') {
    const valid = clean(patch) as Record<string, unknown>;
    for (const f of FIELDS) {
      const v = (patch as Record<string, unknown>)[f];
      if (v === null) delete merged[f];
      else if (valid[f] !== undefined) merged[f] = valid[f];
    }
    // providers merges per provider: { claude: false } changes only Claude.
    const p = (patch as Record<string, unknown>).providers;
    if (p === null) delete merged.providers;
    else if (valid.providers) merged.providers = { ...((merged.providers as Record<string, boolean> | undefined) ?? {}), ...(valid.providers as Record<string, boolean>) };
  }
  appState.set(db, MEMORY_SETTINGS_KEY, JSON.stringify(clean(merged)));
  return readMemorySettings(db);
}

/** Whether one project's own scope is on. */
export const projectRemembered = (s: MemorySettings, sessionId: string): boolean => !s.projectsOff.includes(sessionId);

/** "Dispatch reads this provider" (the Dispatch side; the harness's own switch is separate). */
export const providerRead = (s: MemorySettings, id: string): boolean => s.providers[id] === true;
