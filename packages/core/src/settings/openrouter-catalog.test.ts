import { describe, it, expect, beforeEach, vi } from 'vitest';
import { normalizeCatalog, searchCatalog, loadCatalog, resetCatalogCache, type CatalogEntry } from './openrouter-catalog.js';

const raw = {
  data: [
    { id: '~x-ai/grok-latest', name: 'xAI: Grok Latest', context_length: 500000, created: 1751983360, alias_target: { slug: 'x-ai/grok-4.6' } },
    { id: 'x-ai/grok-4.6', name: 'xAI: Grok 4.6', context_length: 500000, created: 1755000000 },
    { id: 'x-ai/grok-4.5', name: 'xAI: Grok 4.5', context_length: 500000, created: 1751980000 },
    { id: 'x-ai/grok-4.6:batch', name: 'xAI: Grok 4.6 (batch)', context_length: 500000, created: 1755000000 },
    { id: 'qwen/qwen3.8-max-0902', name: 'Qwen: Qwen3.8 Max (0902)', context_length: 1000000, created: 1756900000 },
    { id: 42, name: 'broken row' },
    { id: 'mystery/no-name', created: 1 },
  ],
};

describe('normalizeCatalog', () => {
  it('maps rows to OpenCode-namespaced ids with vendor-less labels, and drops batch variants and junk', () => {
    const entries = normalizeCatalog(raw);
    expect(entries.map((e) => e.id)).toEqual([
      'openrouter/~x-ai/grok-latest', 'openrouter/x-ai/grok-4.6', 'openrouter/x-ai/grok-4.5', 'openrouter/qwen/qwen3.8-max-0902', 'openrouter/mystery/no-name',
    ]);
    expect(entries[0]).toMatchObject({ label: 'Grok Latest', name: 'xAI: Grok Latest', alias: true, aliasTarget: 'x-ai/grok-4.6', contextLength: 500000 });
    expect(entries[1].alias).toBe(false);
    expect(entries[1].aliasTarget).toBeUndefined();
    // A row without a name falls back to its id for both.
    expect(entries[4]).toMatchObject({ label: 'mystery/no-name', name: 'mystery/no-name', contextLength: null });
  });

  it('tolerates a non-catalog payload', () => {
    expect(normalizeCatalog(null)).toEqual([]);
    expect(normalizeCatalog({ data: 'nope' })).toEqual([]);
  });
});

describe('searchCatalog', () => {
  const entries = normalizeCatalog(raw);

  it('matches every term against id or name, case-insensitively', () => {
    expect(searchCatalog(entries, 'GROK 4.5').map((e) => e.id)).toEqual(['openrouter/x-ai/grok-4.5']);
    expect(searchCatalog(entries, 'xai grok').map((e) => e.id)).toHaveLength(3);
    expect(searchCatalog(entries, 'nothing-here')).toEqual([]);
  });

  it('ranks aliases first, then newest', () => {
    expect(searchCatalog(entries, 'grok').map((e) => e.id)).toEqual([
      'openrouter/~x-ai/grok-latest', 'openrouter/x-ai/grok-4.6', 'openrouter/x-ai/grok-4.5',
    ]);
  });

  it('an empty query lists everything up to the limit', () => {
    expect(searchCatalog(entries, '', 2)).toHaveLength(2);
    expect(searchCatalog(entries, '   ')).toHaveLength(entries.length);
  });
});

describe('loadCatalog', () => {
  beforeEach(() => resetCatalogCache());

  const okFetch = (payload: unknown) => vi.fn(async () => ({ ok: true, status: 200, json: async () => payload })) as unknown as typeof fetch;

  it('fetches once and serves the cache within the hour', async () => {
    const f = okFetch(raw);
    const a = await loadCatalog(f, 1_000);
    const b = await loadCatalog(f, 1_000 + 30 * 60 * 1000);
    expect(a).toBe(b);
    expect(f).toHaveBeenCalledTimes(1);
    await loadCatalog(f, 1_000 + 61 * 60 * 1000);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('throws on a non-2xx so the route can report the outage instead of an empty list', async () => {
    const f = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch;
    await expect(loadCatalog(f)).rejects.toThrow(/503/);
  });

  it('returns typed entries', async () => {
    const entries: CatalogEntry[] = await loadCatalog(okFetch(raw));
    expect(entries[0].id.startsWith('openrouter/')).toBe(true);
  });
});
