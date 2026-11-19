import type Database from 'better-sqlite3';
import * as appState from '../db/app-state.js';

/**
 * Memory settings (spec 2026-11-17-memory-design.md, section 5.3): one `memory_settings` JSON blob in
 * app_state, the shared-settings pattern. Field-wise merge: a valid field replaces, null clears
 * (back to the default), absent or invalid keeps.
 *
 *   enabled     Memory on or off. Off: no block, no memory tools, and no background reading of
 *               conversations or of Claude Code's memory. Default OFF (owner, 2026-11-19): the person
 *               turns it on in Settings > Memory. A stored value wins.
 *   paused      Threads still read memory; nothing new is saved. Default off.
 *   blockChars  Size cap of the injected block. Default 4,000, at most 8,000, at least 1,000.
 *   projectsOff Session ids of the projects whose own scope is off ("Remember this project" off).
 */
export const MEMORY_SETTINGS_KEY = 'memory_settings';
export const DEFAULT_BLOCK_CHARS = 4000;
export const MAX_BLOCK_CHARS = 8000;
export const MIN_BLOCK_CHARS = 1000;

export interface MemorySettings { enabled: boolean; paused: boolean; blockChars: number; projectsOff: string[] }

const DEFAULTS: MemorySettings = { enabled: false, paused: false, blockChars: DEFAULT_BLOCK_CHARS, projectsOff: [] };
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
  if (Array.isArray(r.projectsOff)) out.projectsOff = [...new Set(r.projectsOff.filter((v): v is string => typeof v === 'string' && ID_RE.test(v)))].slice(0, 1000);
  return out;
}

function stored(db: Database.Database): Partial<MemorySettings> {
  const raw = appState.get(db, MEMORY_SETTINGS_KEY);
  if (raw == null) return {};
  try { return clean(JSON.parse(raw)); } catch { return {}; }
}

export function readMemorySettings(db: Database.Database): MemorySettings {
  return { ...DEFAULTS, ...stored(db) };
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
  }
  appState.set(db, MEMORY_SETTINGS_KEY, JSON.stringify(clean(merged)));
  return readMemorySettings(db);
}

/** Whether one project's own scope is on. */
export const projectRemembered = (s: MemorySettings, sessionId: string): boolean => !s.projectsOff.includes(sessionId);
