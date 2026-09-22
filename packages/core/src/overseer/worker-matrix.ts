import type { AgentType as HarnessType } from '../providers/agent-types.js';
import type { OverseerWorkers, PersonaType, WorkerPick } from '../settings/overseer-workers.js';

/**
 * Resolve which harness/model a Control Plane worker runs on. Precedence
 * (spec: Phase 1 worker resolution order):
 *   explicit spawn args → per-agent-type matrix → session default → claude-code.
 * Fields resolve independently: an explicit model without a harness rides on the
 * otherwise-resolved harness. A returned `model: undefined` means "let the spawn
 * path apply its existing defaults" (claude tiers / opencode settings / CLI default).
 */
export function resolveWorker(input: {
  agentType: PersonaType;
  explicit?: WorkerPick;
  matrix: OverseerWorkers;
  sessionDefault?: HarnessType;
}): { harness: HarnessType; model?: string } {
  const fromMatrix = input.matrix.byType[input.agentType];
  const harness = input.explicit?.harness ?? fromMatrix?.harness ?? input.sessionDefault ?? 'claude-code';
  // A matrix model pinned to a specific harness must not ride a different, resolved harness
  // (e.g. an explicit harness pick that overrides the matrix's own harness). A matrix entry
  // with no harness of its own is harness-agnostic and applies regardless.
  const matrixModelApplies = fromMatrix && (fromMatrix.harness === undefined || fromMatrix.harness === harness);
  const model = input.explicit?.model ?? (matrixModelApplies ? fromMatrix?.model : undefined);
  return model ? { harness, model } : { harness };
}
