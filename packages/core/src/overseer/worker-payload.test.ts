import { describe, it, expect } from 'vitest';
import { buildWorkerCreateBody } from './worker-payload.js';

describe('buildWorkerCreateBody', () => {
  it('claude default matches the pre-selector wire shape exactly', () => {
    expect(buildWorkerCreateBody({ agentType: 'implementer', label: 'implementer agent', resolved: { harness: 'claude-code' }, spawnDepth: 1 }))
      .toEqual({ type: 'claude-code', label: 'implementer agent', config: { transport: 'structured', agentType: 'implementer', role: 'agent', spawnDepth: 1 } });
  });

  it('a resolved non-claude harness sets type and model', () => {
    const body = buildWorkerCreateBody({ agentType: 'planner', label: 'planner agent', resolved: { harness: 'codex', model: 'gpt-5-codex' }, spawnDepth: 1, mission: 'Auth' });
    expect(body.type).toBe('codex');
    expect(body.config).toEqual({ transport: 'structured', agentType: 'planner', role: 'agent', mission: 'Auth', model: 'gpt-5-codex', spawnDepth: 1 });
  });

  it('explicit model overrides the resolved one; queued adds queued+task+dependsOn', () => {
    const body = buildWorkerCreateBody({ agentType: 'reviewer', label: 'r', resolved: { harness: 'grok', model: 'x' }, explicitModel: 'grok-4', spawnDepth: 2, queued: true, task: 'T', dependsOn: 'a1' });
    expect(body).toEqual({
      type: 'grok', label: 'r', queued: true, task: 'T',
      config: { transport: 'structured', agentType: 'reviewer', role: 'agent', dependsOn: 'a1', model: 'grok-4', spawnDepth: 2 },
    });
  });
});
