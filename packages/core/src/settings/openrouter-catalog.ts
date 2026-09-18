/**
 * OpenRouter's public model catalog, for the Settings → Harnesses → OpenCode "add a model"
 * search. The catalog is ~450 ids and changes weekly, so it is fetched live (no key
 * needed — it is a public endpoint), cached in memory for an hour, and searched here
 * rather than shipped to the browser whole.
 */

export const OPENROUTER_CATALOG_URL = 'https://openrouter.ai/api/v1/models';
const CACHE_TTL_MS = 60 * 60 * 1000;

export interface CatalogEntry {
  /** OpenCode-namespaced id, ready for `config.model`: `openrouter/~x-ai/grok-latest`. */
  id: string;
  /** Short label for the picker: the catalog name minus its `Vendor: ` prefix. */
  label: string;
  /** The catalog's full display name (`xAI: Grok Latest`). */
  name: string;
  contextLength: number | null;
  /** Unix seconds the id appeared in the catalog. */
  created: number;
  /** True for a `~vendor/family-latest` alias that always resolves to the family's flagship. */
  alias: boolean;
  /** For an alias: the concrete id it resolves to today. */
  aliasTarget?: string;
}

/** The subset of OpenRouter's `/models` row shape this module reads. */
interface RawModel {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  created?: unknown;
  alias_target?: { slug?: unknown } | null;
}

/** `openrouter/<id>` — how OpenCode addresses an OpenRouter model. */
export const toOpencodeId = (id: string): string => `openrouter/${id}`;

/**
 * Map the raw catalog into picker entries. Drops `:batch` variants (async-only, no use in
 * an interactive thread) and anything without a string id.
 */
export function normalizeCatalog(raw: unknown): CatalogEntry[] {
  const rows: RawModel[] = Array.isArray((raw as { data?: unknown })?.data) ? (raw as { data: RawModel[] }).data : [];
  const out: CatalogEntry[] = [];
  for (const row of rows) {
    if (typeof row?.id !== 'string' || !row.id) continue;
    if (row.id.endsWith(':batch')) continue;
    const name = typeof row.name === 'string' && row.name ? row.name : row.id;
    const aliasTarget = typeof row.alias_target?.slug === 'string' ? row.alias_target.slug : undefined;
    out.push({
      id: toOpencodeId(row.id),
      label: name.replace(/^[^:]+:\s*/, ''),
      name,
      contextLength: typeof row.context_length === 'number' ? row.context_length : null,
      created: typeof row.created === 'number' ? row.created : 0,
      alias: row.id.startsWith('~'),
      ...(aliasTarget ? { aliasTarget } : {}),
    });
  }
  return out;
}

/**
 * Every whitespace-separated term must appear in the id or the name (case-insensitive).
 * Aliases rank first — they are what a user should usually pick — then newest first.
 */
export function searchCatalog(entries: CatalogEntry[], query: string, limit = 40): CatalogEntry[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = entries.filter((e) => {
    const hay = `${e.id} ${e.name}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
  hits.sort((a, b) => Number(b.alias) - Number(a.alias) || b.created - a.created || a.id.localeCompare(b.id));
  return hits.slice(0, limit);
}

let cache: { at: number; entries: CatalogEntry[] } | null = null;

/** The catalog, fetched at most once an hour. Throws when OpenRouter is unreachable. */
export async function loadCatalog(fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<CatalogEntry[]> {
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.entries;
  const res = await fetchImpl(OPENROUTER_CATALOG_URL, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`OpenRouter catalog returned HTTP ${res.status}`);
  const entries = normalizeCatalog(await res.json());
  cache = { at: now, entries };
  return entries;
}

/** Test seam. */
export function resetCatalogCache(): void { cache = null; }
