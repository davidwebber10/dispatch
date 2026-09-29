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

  describe('non-Claude model on claude-code guard', () => {
    // The reverse of the tier-alias guard. The model never picks the harness: a coordinator that
    // passes model "gpt-6-astra" without harness "codex" lands on claude-code, and the Claude CLI
    // then fails with "There's an issue with the selected model". Fail at spawn instead, before a
    // thread exists, and name the harness that runs the model.
    for (const model of ['gpt-6-astra', 'GPT-6-Astra', 'gpt-5.6-sol', 'o3']) {
      it(`throws when explicit model '${model}' targets claude-code, and names codex`, () => {
        expect(() => buildWorkerCreateBody({
          agentType: 'researcher', label: 'r', resolved: { harness: 'claude-code' }, explicitModel: model, spawnDepth: 1,
        })).toThrow(`model '${model}' is not a Claude model, so claude-code cannot run it — the model never picks the harness; pass harness 'codex' with it`);
      });
    }

    it('names grok for a grok model', () => {
      expect(() => buildWorkerCreateBody({
        agentType: 'researcher', label: 'r', resolved: { harness: 'claude-code' }, explicitModel: 'grok-4.5', spawnDepth: 1,
      })).toThrow(/pass harness 'grok' with it/);
    });

    it('throws when the RESOLVED (non-explicit) model is a GPT model on claude-code', () => {
      expect(() => buildWorkerCreateBody({
        agentType: 'researcher', label: 'r', resolved: { harness: 'claude-code', model: 'gpt-6-astra' }, spawnDepth: 1,
      })).toThrow(/not a Claude model/);
    });

    it('a Claude alias, a full Claude id, or no model is fine on claude-code', () => {
      for (const explicitModel of ['opus', 'claude-opus-4-8', 'claude-sonnet-5', undefined]) {
        expect(() => buildWorkerCreateBody({
          agentType: 'researcher', label: 'r', resolved: { harness: 'claude-code' }, explicitModel, spawnDepth: 1,
        })).not.toThrow();
      }
    });
  });
});
