import { measurementsFromFrame } from '../analytics/normalize.js';
import type { Measurement } from '../db/telemetry.js';
import type { NormalizedEvent } from '../status/events.js';

/** Provider overrides at the boundary; storage and turn accounting stay shared. */
export interface ProviderTelemetry {
  runnerFrame: (frame: unknown) => unknown;
  normalizeUsage: (frame: unknown) => Measurement[];
  hookNames: readonly string[];
  normalizeHook: (payload: unknown) => NormalizedEvent;
  /** null explicitly means this transport cannot report usage. */
  ptyCapture: 'claude-transcript' | 'codex-transcript' | null;
  /** Optional cumulative USD counter; the ledger persists its baseline. */
  costCounter: (frame: unknown) => number | null;
  /** Per-turn dollars reported by the harness; may themselves be estimates. */
  reportedCost: (frame: unknown) => number | null;
}

export const DEFAULT_TELEMETRY: ProviderTelemetry = {
  normalizeUsage: measurementsFromFrame,
  runnerFrame: (frame) => frame,
  hookNames: [],
  normalizeHook: () => ({ status: null }),
  ptyCapture: null,
  reportedCost: () => null,
  costCounter: () => null,
};

/** ACP's translator has already converted cumulative cost into a turn delta. */
export function acpTurnCost(frame: unknown): number | null {
  if (!frame || typeof frame !== 'object') return null;
  const f = frame as Record<string, unknown>;
  return f.type === 'result' && f.subtype === 'acp_turn'
    && typeof f.total_cost_usd === 'number' && Number.isFinite(f.total_cost_usd) && f.total_cost_usd >= 0
    ? f.total_cost_usd : null;
}

export function acpCostCounter(frame: unknown): number | null {
  const f = frame as any;
  const total = f?.telemetry?.costTotalUsd;
  return f?.type === 'result' && f?.subtype === 'acp_turn' && typeof total === 'number' && Number.isFinite(total) && total >= 0 ? total : null;
}
