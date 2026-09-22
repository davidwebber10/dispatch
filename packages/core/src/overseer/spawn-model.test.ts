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
});
