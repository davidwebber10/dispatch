import type Database from 'better-sqlite3';
import * as appState from '../db/app-state.js';
import { isAgentType as isHarnessType, type AgentType as HarnessType } from '../providers/agent-types.js';

/**
 * The Control Plane worker matrix: which harness/model each spawned agent TYPE runs
 * on. Daemon-side (app_state), like harness-settings, because agency-mcp resolves it
 * at spawn time with no browser in the loop. Global on purpose: it survives "New
 * session" and Control Plane resets (spec: per-agent-type plumbing, no UI yet).
 */
export const PERSONA_TYPES = ['planner', 'implementer', 'researcher', 'reviewer', 'design-reviewer', 'code-reviewer'] as const;
export type PersonaType = (typeof PERSONA_TYPES)[number];

export interface WorkerPick { harness?: HarnessType; model?: string }
export interface OverseerWorkers { byType: Partial<Record<PersonaType, WorkerPick>> }

const STATE_KEY = 'overseer_workers';

const pickString = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

function sanitizePick(v: unknown): WorkerPick | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const rec = v as Record<string, unknown>;
  const out: WorkerPick = {};
  const harness = pickString(rec.harness);
  if (harness && isHarnessType(harness)) out.harness = harness;
  const model = pickString(rec.model);
  if (model) out.model = model;
  return Object.keys(out).length ? out : undefined;
}

function sanitize(raw: unknown): OverseerWorkers {
  const out: OverseerWorkers = { byType: {} };
  if (!raw || typeof raw !== 'object') return out;
  const byType = (raw as Record<string, unknown>).byType;
  if (!byType || typeof byType !== 'object') return out;
  for (const type of PERSONA_TYPES) {
    const pick = sanitizePick((byType as Record<string, unknown>)[type]);
    if (pick) out.byType[type] = pick;
  }
  return out;
}

export function readOverseerWorkers(db: Database.Database): OverseerWorkers {
  const stored = appState.get(db, STATE_KEY);
  if (stored == null) return { byType: {} };
  try { return sanitize(JSON.parse(stored)); } catch { return { byType: {} }; }
}

/** Merge per persona type; explicit null clears that type's entry. */
export function updateOverseerWorkers(db: Database.Database, patch: unknown): OverseerWorkers {
  const current = readOverseerWorkers(db);
  if (patch && typeof patch === 'object') {
    const byType = (patch as Record<string, unknown>).byType;
    if (byType && typeof byType === 'object') {
      for (const type of PERSONA_TYPES) {
        const p = (byType as Record<string, unknown>)[type];
        if (p === undefined) continue;
        if (p === null) { delete current.byType[type]; continue; }
        const patchPick = p as Record<string, unknown>;
        const stored = current.byType[type];
        // A patch that changes the harness WITHOUT also supplying a model is switching
        // harnesses, not tweaking one — the stored model belonged to the OLD harness and
        // must not silently carry over onto the new one (it may not even be a valid model
        // id there). A patch that supplies both keeps the new model as given.
        const switchingHarness =
          stored?.harness !== undefined &&
          typeof patchPick.harness === 'string' &&
          patchPick.harness !== stored.harness &&
          patchPick.model === undefined;
        const base = switchingHarness ? { ...stored, model: undefined } : stored;
        current.byType[type] = { ...(base ?? {}), ...patchPick } as WorkerPick;
      }
    }
  }
  const clean = sanitize(current);
  appState.set(db, STATE_KEY, JSON.stringify(clean));
  return clean;
}
