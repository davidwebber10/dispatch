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

  describe('Claude tier alias guard', () => {
    // Spec constraint: sonnet/opus/haiku/fable must NEVER reach a non-Claude CLI, whether the
    // alias arrives as an explicit model override or as the resolved (matrix/session-default)
    // model — a non-claude-code harness with one of these strings is always a mistake.
    for (const alias of ['sonnet', 'opus', 'haiku', 'fable']) {
      it(`throws when explicit model '${alias}' targets a non-claude-code harness (codex)`, () => {
        expect(() => buildWorkerCreateBody({
          agentType: 'implementer', label: 'r', resolved: { harness: 'codex' }, explicitModel: alias, spawnDepth: 1,
        })).toThrow(`model '${alias}' is a Claude tier alias — not valid for harness 'codex'; pass that harness's own model id or omit model`);
      });
    }

    it('throws when the RESOLVED (non-explicit) model is a Claude tier alias targeting codex', () => {
      expect(() => buildWorkerCreateBody({
        agentType: 'implementer', label: 'r', resolved: { harness: 'codex', model: 'opus' }, spawnDepth: 1,
      })).toThrow(/Claude tier alias/);
    });

    it('a Claude tier alias is fine when the harness is claude-code', () => {
      expect(() => buildWorkerCreateBody({
        agentType: 'implementer', label: 'r', resolved: { harness: 'claude-code' }, explicitModel: 'opus', spawnDepth: 1,
      })).not.toThrow();
    });

    it('a real non-Claude model id on a non-Claude harness is fine', () => {
      expect(() => buildWorkerCreateBody({
        agentType: 'implementer', label: 'r', resolved: { harness: 'codex', model: 'gpt-5-codex' }, spawnDepth: 1,
      })).not.toThrow();
    });
  });
});
