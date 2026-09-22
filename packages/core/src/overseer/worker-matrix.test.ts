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

  it('a matrix model with no harness pinned does NOT apply once the caller gives an explicit harness', () => {
    // Changed by the fix (Finding B): a harness-agnostic matrix entry is only meant for the
    // resolution the caller left up to us (matrix/session-default) — an explicit harness pick
    // is the caller overriding that resolution outright, so the model doesn't ride along.
    const matrix = { byType: { implementer: { model: 'gpt-5-codex' } } };
    expect(resolveWorker({ agentType: 'implementer', explicit: { harness: 'codex' }, matrix }))
      .toEqual({ harness: 'codex' });
  });

  it('a harness-agnostic matrix model does not leak onto an EXPLICIT different harness', () => {
    const matrix = { byType: { implementer: { model: 'gpt-5-codex' } } };
    // The matrix entry has no harness of its own, but the caller gave an EXPLICIT harness
    // (grok) that differs from the session default (codex) the model was implicitly meant
    // for — the model must not ride onto grok uninvited.
    expect(resolveWorker({ agentType: 'implementer', explicit: { harness: 'grok' }, matrix, sessionDefault: 'codex' }))
      .toEqual({ harness: 'grok' });
  });

  it('a matrix model pinned to a DIFFERENT harness than the resolved one does not ride along', () => {
    const matrix = { byType: { implementer: { harness: 'grok' as const, model: 'grok-4' } } };
    // Explicit harness (codex) wins over the matrix's harness (grok); the matrix's model was
    // meant for grok specifically, so it must not leak onto codex.
    expect(resolveWorker({ agentType: 'implementer', explicit: { harness: 'codex' }, matrix }))
      .toEqual({ harness: 'codex' });
  });
});
