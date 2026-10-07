import { loadCatalog, peekCatalog } from './openrouter-catalog.js';

/**
 * Does a model accept a tool list? Every agent harness Dispatch drives (Claude Code, Codex,
 * Grok, OpenCode) sends tool definitions on every request, and a provider with no
 * tool-capable endpoint rejects the whole request ("No endpoints found that support tool
 * use" on OpenRouter). The spawn path asks here BEFORE writing the OpenCode config, so such
 * a model runs chat-only (providers/opencode-config.ts toolsDisabled) instead of failing on
 * its first turn.
 *
 * Two sources, by the id's provider prefix (OpenCode's `<provider>/<model>` namespace):
 *   openrouter/…   OpenRouter's own catalog (settings/openrouter-catalog.ts), the same
 *                  hourly cache the picker searches — `supported_parameters` ∋ 'tools'.
 *   anything else  models.dev's api.json, the catalog OpenCode itself reads for every other
 *                  provider (ollama, lmstudio, llama, …) — the `tool_call` flag.
 *
 * Unknown model, unknown provider, or an unreachable catalog ⇒ true. That is today's
 * behavior (tools are sent), and a wrong guess fails loudly on the first request rather
 * than silently stripping tools from a capable model.
 */

export const MODELS_DEV_URL = 'https://models.dev/api.json';
const CACHE_TTL_MS = 60 * 60 * 1000;

/** provider → model id → tool_call (only the field this module reads). */
type ModelsDevIndex = Record<string, Record<string, boolean | undefined>>;

let modelsDevCache: { at: number; index: ModelsDevIndex } | null = null;

function indexModelsDev(raw: unknown): ModelsDevIndex {
  const index: ModelsDevIndex = {};
  if (!raw || typeof raw !== 'object') return index;
  for (const [provider, entry] of Object.entries(raw as Record<string, unknown>)) {
    const models = (entry as { models?: unknown } | null)?.models;
    if (!models || typeof models !== 'object') continue;
    const byId: Record<string, boolean | undefined> = {};
    for (const [id, m] of Object.entries(models as Record<string, unknown>)) {
      const toolCall = (m as { tool_call?: unknown } | null)?.tool_call;
      byId[id] = typeof toolCall === 'boolean' ? toolCall : undefined;
    }
    index[provider] = byId;
  }
  return index;
}

async function loadModelsDev(fetchImpl: typeof fetch, now: number): Promise<ModelsDevIndex> {
  if (modelsDevCache && now - modelsDevCache.at < CACHE_TTL_MS) return modelsDevCache.index;
  const res = await fetchImpl(MODELS_DEV_URL, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`models.dev returned HTTP ${res.status}`);
  const index = indexModelsDev(await res.json());
  modelsDevCache = { at: now, index };
  return index;
}

/** Test seam. */
export function resetModelsDevCache(): void { modelsDevCache = null; }

/**
 * The spawn path is synchronous (spawnTerminal → spawnStructured, many call sites), so it
 * cannot await a catalog. This answers from whatever is cached — null when the needed
 * catalog has not loaded yet — and kicks the load so the NEXT ask (or the boot-time
 * warmModelCapabilities) has it. Callers treat null as "tools on" and must not persist it.
 */
export function modelSupportsToolsCached(modelId: string, fetchImpl: typeof fetch = fetch, now = Date.now()): boolean | null {
  const slash = modelId.indexOf('/');
  if (slash <= 0) return true;
  const provider = modelId.slice(0, slash);
  const id = modelId.slice(slash + 1);
  if (provider === 'openrouter') {
    const entries = peekCatalog();
    if (!entries) { void modelSupportsTools(modelId, fetchImpl, now); return null; }
    const entry = entries.find((e) => e.id === modelId);
    return entry ? entry.tools : true;
  }
  if (!modelsDevCache) { void modelSupportsTools(modelId, fetchImpl, now); return null; }
  return modelsDevCache.index[provider]?.[id] !== false;
}

/** Load both catalogs once (server boot). An outage is swallowed: lookups then fail open. */
export async function warmModelCapabilities(fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<void> {
  await Promise.all([
    loadCatalog(fetchImpl, now).catch(() => undefined),
    loadModelsDev(fetchImpl, now).catch(() => undefined),
  ]);
}

export async function modelSupportsTools(modelId: string, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<boolean> {
  const slash = modelId.indexOf('/');
  if (slash <= 0) return true;
  const provider = modelId.slice(0, slash);
  const id = modelId.slice(slash + 1);
  try {
    if (provider === 'openrouter') {
      const entry = (await loadCatalog(fetchImpl, now)).find((e) => e.id === modelId);
      return entry ? entry.tools : true;
    }
    const toolCall = (await loadModelsDev(fetchImpl, now))[provider]?.[id];
    return toolCall !== false;
  } catch {
    return true;
  }
}
