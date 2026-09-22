/**
 * The terminals-create body for a Control Plane worker. Extracted pure so the wire
 * shape is testable without running the agency-mcp process. Field order and omission
 * rules mirror the historical spawnAgent/queueAgent bodies exactly — the claude-code
 * default case must stay byte-compatible with pre-selector daemons' expectations.
 */
export function buildWorkerCreateBody(input: {
  agentType: string; label: string;
  resolved: { harness: string; model?: string };
  explicitModel?: string; mission?: string; dependsOn?: string;
  spawnDepth: number; queued?: boolean; task?: string;
}): Record<string, unknown> {
  const model = input.explicitModel || input.resolved.model || '';
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
