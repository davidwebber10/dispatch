import { describe, it, expect } from 'vitest';
import { friendlyModelName, modelFromFrame, modelOptionsFor } from './modelName';

describe('friendlyModelName — one label for a model everywhere in Pretty', () => {
  it('Claude ids and aliases', () => {
    expect(friendlyModelName('claude-opus-5-5')).toBe('Opus 5.5');
    expect(friendlyModelName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(friendlyModelName('claude-opus-5-5[1m]')).toBe('Opus 5.5 (1M)');
    expect(friendlyModelName('opus')).toBe('Opus');
    expect(friendlyModelName('fable')).toBe('Fable');
  });

  it('Codex, Grok, and OpenCode ids', () => {
    expect(friendlyModelName('gpt-6-astra')).toBe('GPT-6 Astra');
    expect(friendlyModelName('gpt-5.6-sol')).toBe('GPT-5.6 Sol');
    expect(friendlyModelName('grok-4.7')).toBe('Grok 4.7');
    expect(friendlyModelName('grok-4.7-build-fast')).toBe('Grok 4.7 Build Fast');
    expect(friendlyModelName('openrouter/moonshotai/kimi-k3', [{ label: 'Kimi K3', model: 'openrouter/moonshotai/kimi-k3' }])).toBe('Kimi K3');
    expect(friendlyModelName('openrouter/moonshotai/kimi-k3')).toBe('kimi-k3');
  });

  it('nothing for nothing', () => {
    expect(friendlyModelName(undefined)).toBeUndefined();
    expect(friendlyModelName('')).toBeUndefined();
  });
});

describe('modelFromFrame — which frames name the active model', () => {
  it('init, the daemon model frame, and a lead assistant frame', () => {
    expect(modelFromFrame({ type: 'system', subtype: 'init', model: 'claude-opus-5-5' })).toBe('claude-opus-5-5');
    expect(modelFromFrame({ type: 'system', subtype: 'model', model: 'gpt-5.6-luna' })).toBe('gpt-5.6-luna');
    expect(modelFromFrame({ type: 'assistant', parent_tool_use_id: null, message: { model: 'claude-haiku-5-5', content: [] } })).toBe('claude-haiku-5-5');
  });

  it('never a sub-agent, a synthetic frame, or a frame without one', () => {
    expect(modelFromFrame({ type: 'assistant', parent_tool_use_id: 'toolu_1', message: { model: 'claude-haiku-5-5' } })).toBeUndefined();
    expect(modelFromFrame({ type: 'assistant', message: { model: '<synthetic>' } })).toBeUndefined();
    expect(modelFromFrame({ type: 'system', subtype: 'init' })).toBeUndefined();
    expect(modelFromFrame({ type: 'result' })).toBeUndefined();
  });
});

describe('modelOptionsFor — the switcher list per harness', () => {
  it('the catalog models (no "Default": a switch needs a concrete model)', () => {
    expect(modelOptionsFor('claude-code').map((o) => o.value)).toEqual(['fable', 'opus', 'sonnet', 'haiku']);
    expect(modelOptionsFor('codex').map((o) => o.label)).toEqual(['GPT-6 Astra', 'GPT-5.6 Sol', 'GPT-5.6 Terra', 'GPT-5.6 Luna']);
  });

  it('OpenCode comes from the per-user list; a running model the list lacks is kept on top', () => {
    expect(modelOptionsFor('opencode', [{ label: 'Kimi K3', model: 'openrouter/moonshotai/kimi-k3' }]).map((o) => o.value)).toEqual(['openrouter/moonshotai/kimi-k3']);
    expect(modelOptionsFor('grok', [], 'grok-4.7').map((o) => o.value)).toEqual(['grok-4.7', 'grok-4.5']);
  });

  it('a running id that is the family of an alias in the list does not duplicate it', () => {
    expect(modelOptionsFor('claude-code', [], 'claude-opus-5-5').map((o) => o.value)).toEqual(['fable', 'opus', 'sonnet', 'haiku']);
  });
});
