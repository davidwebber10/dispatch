import { loadCatalog } from './openrouter-catalog.js';

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
