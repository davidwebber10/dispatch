import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import { readHarnessSettings, updateHarnessSettings, opencodeModels } from './harness-settings.js';
import { OPENCODE_DEFAULT_MODELS } from '../providers/opencode.js';

function db() { const d = new Database(':memory:'); initSchema(d); return d; }

describe('harness settings — opencode model list', () => {
  it('serves the curated defaults when nothing is stored', () => {
    const d = db();
    expect(readHarnessSettings(d).opencode?.models).toBeUndefined();
    expect(opencodeModels(d)).toEqual(OPENCODE_DEFAULT_MODELS);
  });

  it('stores a replacement list, trimmed and de-duplicated by id', () => {
    const d = db();
    updateHarnessSettings(d, { opencode: { models: [
      { label: ' GLM ', model: ' openrouter/~z-ai/glm-latest ' },
      { label: 'GLM again', model: 'openrouter/~z-ai/glm-latest' },
      { label: 'Kimi', model: 'openrouter/~moonshotai/kimi-latest' },
    ] } });
    expect(opencodeModels(d)).toEqual([
      { label: 'GLM', model: 'openrouter/~z-ai/glm-latest' },
      { label: 'Kimi', model: 'openrouter/~moonshotai/kimi-latest' },
    ]);
  });

  it('drops malformed entries and never stores an empty list', () => {
    const d = db();
    updateHarnessSettings(d, { opencode: { models: [{ label: 'no id' }, { model: 'openrouter/x' }, 'junk', { label: 'ok', model: 'openrouter/y' }] } });
    expect(opencodeModels(d)).toEqual([{ label: 'ok', model: 'openrouter/y' }]);
    // An all-bad list is the same as clearing: back to the defaults.
    updateHarnessSettings(d, { opencode: { models: [{ label: 'no id' }] } });
    expect(opencodeModels(d)).toEqual(OPENCODE_DEFAULT_MODELS);
  });

  it('null clears the list back to the defaults, and leaves the other fields alone', () => {
    const d = db();
    updateHarnessSettings(d, { opencode: { defaultModel: 'openrouter/~moonshotai/kimi-latest', models: [{ label: 'Kimi', model: 'openrouter/~moonshotai/kimi-latest' }] } });
    updateHarnessSettings(d, { opencode: { models: null } });
    expect(opencodeModels(d)).toEqual(OPENCODE_DEFAULT_MODELS);
    expect(readHarnessSettings(d).opencode?.defaultModel).toBe('openrouter/~moonshotai/kimi-latest');
  });

  it('ignores a model list on any harness but opencode', () => {
    const d = db();
    updateHarnessSettings(d, { 'claude-code': { models: [{ label: 'x', model: 'y' }] } });
    expect(readHarnessSettings(d)['claude-code']).toBeUndefined();
  });

  it('every curated default is an OpenCode-namespaced OpenRouter id with a label', () => {
    for (const m of OPENCODE_DEFAULT_MODELS) {
      expect(m.model).toMatch(/^openrouter\/[^/]+\/[^/]+/);
      expect(m.label.trim().length).toBeGreaterThan(0);
    }
    const ids = OPENCODE_DEFAULT_MODELS.map((m) => m.model);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
