/**
 * The terminals-create body for a Control Plane worker. Extracted pure so the wire
 * shape is testable without running the agency-mcp process. Field order and omission
 * rules mirror the historical spawnAgent/queueAgent bodies exactly — the claude-code
 * default case must stay byte-compatible with pre-selector daemons' expectations.
 */
/** Claude tier aliases — resolved downstream by the claude-code spawn path (--model sonnet
 *  etc.), meaningless (and often a different, real model id in disguise) to any other CLI. */
const CLAUDE_TIER_ALIASES = new Set(['sonnet', 'opus', 'haiku', 'fable']);

export function buildWorkerCreateBody(input: {
  agentType: string; label: string;
  resolved: { harness: string; model?: string };
  explicitModel?: string; mission?: string; dependsOn?: string;
  spawnDepth: number; queued?: boolean; task?: string;
}): Record<string, unknown> {
  const model = input.explicitModel || input.resolved.model || '';
  // Spec constraint: sonnet/opus/haiku/fable must NEVER reach a non-Claude CLI, whether they
  // arrive as an explicit override or as the already-resolved model (matrix/session default).
  if (input.resolved.harness !== 'claude-code' && CLAUDE_TIER_ALIASES.has(model)) {
    throw new Error(`model '${model}' is a Claude tier alias — not valid for harness '${input.resolved.harness}'; pass that harness's own model id or omit model`);
  }
  return {
    type: input.resolved.harness,
    label: input.label,
    ...(input.queued ? { queued: true, task: input.task ?? '' } : {}),
    config: {
      transport: 'structured', agentType: input.agentType, role: 'agent',
      ...(input.mission ? { mission: input.mission } : {}),
      ...(input.dependsOn ? { dependsOn: input.dependsOn } : {}),
      ...(model ? { model } : {}),
      spawnDepth: input.spawnDepth,
    },
  };
}
