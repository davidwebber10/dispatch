import { describe, it, expect } from 'vitest';
import { resolveSpawnModel } from './spawn-model.js';

describe('resolveSpawnModel', () => {
  it('claude-code coordinator gets the sonnet tier', () => {
    expect(resolveSpawnModel({ harness: 'claude-code', config: { role: 'coordinator' } })).toBe('sonnet');
  });

  it('claude-code agentType gets its tier', () => {
    expect(resolveSpawnModel({ harness: 'claude-code', config: { agentType: 'researcher', role: 'agent' } })).toBe('opus');
  });

  it('a non-claude worker NEVER receives a Claude tier alias', () => {
    expect(resolveSpawnModel({ harness: 'codex', config: { agentType: 'researcher', role: 'agent' } })).toBeUndefined();
    expect(resolveSpawnModel({ harness: 'grok', config: { role: 'coordinator' } })).toBeUndefined();
  });

  it('an explicit config.model wins on every harness', () => {
    expect(resolveSpawnModel({ harness: 'codex', config: { model: 'gpt-5-codex', agentType: 'implementer' } })).toBe('gpt-5-codex');
  });

  it('opencode falls back to its harness default', () => {
    expect(resolveSpawnModel({ harness: 'opencode', config: { agentType: 'implementer' }, opencodeDefault: 'openrouter/z' })).toBe('openrouter/z');
  });

  // Finding E: a Claude tier alias (sonnet/opus/haiku/fable) configured as a HARNESS DEFAULT
  // model must not slip through the guard that only checked explicit `config.model` before.
  it('opencode ignores an explicit Claude tier alias and falls through to its harness default', () => {
    expect(resolveSpawnModel({ harness: 'opencode', config: { model: 'sonnet' }, opencodeDefault: 'openrouter/z' })).toBe('openrouter/z');
  });

  it('opencode whose OWN default is a poisoned Claude tier alias never returns it (undefined, not the alias)', () => {
    expect(resolveSpawnModel({ harness: 'opencode', config: {}, opencodeDefault: 'sonnet' })).toBeUndefined();
  });

  it('codex ignores an explicit Claude tier alias and falls through (undefined — codex has no harness default here)', () => {
    expect(resolveSpawnModel({ harness: 'codex', config: { model: 'opus' } })).toBeUndefined();
  });

  // Task 7: MODEL_FOR_TYPE.coordinator = 'sonnet' must never leak to a codex coordinator —
  // resolveSpawnModel only consults MODEL_FOR_TYPE (via modelFor) on the claude-code branch,
  // so a codex coordinator with no explicit model falls through to undefined, letting the
  // codex CLI apply its own configured default rather than an alias meaningless to it.
  it('a codex coordinator with no explicit model never gets the claude sonnet tier', () => {
    expect(resolveSpawnModel({ harness: 'codex', config: { role: 'coordinator' } })).toBeUndefined();
  });
});

describe('isClaudeTierAlias', () => {
  it('is true for each Claude tier alias and false for a real model id', async () => {
    const { isClaudeTierAlias } = await import('./spawn-model.js');
    for (const alias of ['sonnet', 'opus', 'haiku', 'fable']) expect(isClaudeTierAlias(alias)).toBe(true);
    expect(isClaudeTierAlias('gpt-5-codex')).toBe(false);
  });
});
