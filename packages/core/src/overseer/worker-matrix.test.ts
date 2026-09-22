import { describe, it, expect } from 'vitest';
import { resolveWorker } from './worker-matrix.js';

const empty = { byType: {} };

describe('resolveWorker', () => {
  it('defaults to claude-code with no model (existing tiers apply downstream)', () => {
    expect(resolveWorker({ agentType: 'implementer', matrix: empty })).toEqual({ harness: 'claude-code' });
  });

  it('explicit args win over everything', () => {
    const matrix = { byType: { implementer: { harness: 'grok' as const, model: 'x' } } };
    expect(resolveWorker({ agentType: 'implementer', explicit: { harness: 'codex', model: 'gpt-5-codex' }, matrix, sessionDefault: 'opencode' }))
      .toEqual({ harness: 'codex', model: 'gpt-5-codex' });
  });

  it('explicit model without harness keeps the resolved harness', () => {
    expect(resolveWorker({ agentType: 'researcher', explicit: { model: 'opus' }, matrix: empty }))
      .toEqual({ harness: 'claude-code', model: 'opus' });
  });

  it('matrix entry beats session default', () => {
    const matrix = { byType: { planner: { harness: 'grok' as const } } };
    expect(resolveWorker({ agentType: 'planner', matrix, sessionDefault: 'codex' })).toEqual({ harness: 'grok' });
  });

  it('session default applies when the matrix has no entry for the type', () => {
    expect(resolveWorker({ agentType: 'reviewer', matrix: empty, sessionDefault: 'codex' })).toEqual({ harness: 'codex' });
  });

  it('a matrix model rides only with its own harness pick', () => {
    const matrix = { byType: { implementer: { model: 'gpt-5-codex' } } };
    // Matrix sets only a model: it applies on top of the session-default harness.
    expect(resolveWorker({ agentType: 'implementer', matrix, sessionDefault: 'codex' }))
      .toEqual({ harness: 'codex', model: 'gpt-5-codex' });
  });
});
