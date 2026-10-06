import { describe, it, expect, beforeEach, vi } from 'vitest';
import { modelSupportsTools, modelSupportsToolsCached, warmModelCapabilities, resetModelsDevCache, MODELS_DEV_URL } from './model-capabilities.js';
import { OPENROUTER_CATALOG_URL, resetCatalogCache } from './openrouter-catalog.js';

const openrouter = {
  data: [
    { id: '~z-ai/glm-latest', name: 'Z.AI: GLM Latest', supported_parameters: ['tools', 'tool_choice'] },
    { id: 'cognitivecomputations/dolphin-mistral-24b-venice-edition', name: 'Venice: Uncensored', supported_parameters: ['temperature', 'top_p'] },
  ],
};

const modelsDev = {
  ollama: {
    models: {
      'llama3.3': { id: 'llama3.3', tool_call: true },
      'gemma3': { id: 'gemma3', tool_call: false },
    },
  },
};

/** A fetch that serves both catalogs by URL and 500s anything else. */
const fakeFetch = (overrides: Partial<Record<string, unknown>> = {}) =>
  vi.fn(async (url: string | URL | Request) => {
    const key = String(url);
    const body = key in overrides ? overrides[key] : key === OPENROUTER_CATALOG_URL ? openrouter : key === MODELS_DEV_URL ? modelsDev : undefined;
    if (body === undefined) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body };
  }) as unknown as typeof fetch;

describe('modelSupportsTools', () => {
  beforeEach(() => { resetCatalogCache(); resetModelsDevCache(); });

  it('answers from the OpenRouter catalog for an openrouter/ id', async () => {
    const fetchImpl = fakeFetch();
    expect(await modelSupportsTools('openrouter/~z-ai/glm-latest', fetchImpl)).toBe(true);
    expect(await modelSupportsTools('openrouter/cognitivecomputations/dolphin-mistral-24b-venice-edition', fetchImpl)).toBe(false);
  });

  it('answers from models.dev for any other provider, e.g. a local ollama model', async () => {
    const fetchImpl = fakeFetch();
    expect(await modelSupportsTools('ollama/llama3.3', fetchImpl)).toBe(true);
    expect(await modelSupportsTools('ollama/gemma3', fetchImpl)).toBe(false);
  });

  it('assumes tool support for a model neither catalog knows', async () => {
    const fetchImpl = fakeFetch();
    expect(await modelSupportsTools('openrouter/brand-new/model', fetchImpl)).toBe(true);
    expect(await modelSupportsTools('ollama/unlisted', fetchImpl)).toBe(true);
    expect(await modelSupportsTools('lmstudio/anything', fetchImpl)).toBe(true);
    expect(await modelSupportsTools('no-slash-at-all', fetchImpl)).toBe(true);
  });

  it('fails open when a catalog is unreachable', async () => {
    const down = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch;
    expect(await modelSupportsTools('openrouter/cognitivecomputations/dolphin-mistral-24b-venice-edition', down)).toBe(true);
    expect(await modelSupportsTools('ollama/gemma3', down)).toBe(true);
  });

  it('answers synchronously from the caches once they are warm, and null (kicking a load) before', async () => {
    const fetchImpl = fakeFetch();
    // Cold: the spawn path cannot wait, so it gets "unknown" — and the kick fills the cache.
    expect(modelSupportsToolsCached('openrouter/cognitivecomputations/dolphin-mistral-24b-venice-edition', fetchImpl)).toBeNull();
    expect(modelSupportsToolsCached('ollama/gemma3', fetchImpl)).toBeNull();
    await warmModelCapabilities(fetchImpl);
    expect(modelSupportsToolsCached('openrouter/cognitivecomputations/dolphin-mistral-24b-venice-edition', fetchImpl)).toBe(false);
    expect(modelSupportsToolsCached('openrouter/~z-ai/glm-latest', fetchImpl)).toBe(true);
    expect(modelSupportsToolsCached('ollama/gemma3', fetchImpl)).toBe(false);
    expect(modelSupportsToolsCached('ollama/unlisted', fetchImpl)).toBe(true);
    expect(modelSupportsToolsCached('no-slash-at-all', fetchImpl)).toBe(true);
  });

  it('warmModelCapabilities swallows a catalog outage', async () => {
    const down = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch;
    await expect(warmModelCapabilities(down)).resolves.toBeUndefined();
    expect(modelSupportsToolsCached('openrouter/anything', down)).toBeNull();
  });

  it('fetches models.dev once per hour', async () => {
    const fetchImpl = fakeFetch();
    await modelSupportsTools('ollama/gemma3', fetchImpl, 1_000);
    await modelSupportsTools('ollama/llama3.3', fetchImpl, 2_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await modelSupportsTools('ollama/llama3.3', fetchImpl, 1_000 + 61 * 60 * 1000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
