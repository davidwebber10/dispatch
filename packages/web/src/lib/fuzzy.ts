/**
 * Fuzzy path matching for the Files search: case-insensitive, returns the matched
 * character indices (for highlighting) plus a rank score, or null for no match.
 *
 * Ranking, best first:
 *  1. substring hit inside the basename
 *  2. substring hit anywhere in the path
 *  3. in-order subsequence (classic fuzzy), penalised per gap
 * Ties break toward earlier hits and shorter paths, so `app` finds App.tsx before
 * packages/web/src/components/AppShellWrapper.test.tsx.
 */
export interface FuzzyResult { indices: number[]; score: number }

export function fuzzyMatch(query: string, text: string): FuzzyResult | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return { indices: [], score: 0 };

  const start = t.indexOf(q);
  if (start >= 0) {
    const baseStart = t.lastIndexOf('/') + 1;
    const inBasename = start >= baseStart;
    const indices = Array.from({ length: q.length }, (_, i) => start + i);
    return { indices, score: (inBasename ? 2000 : 1000) - start - text.length * 0.01 };
  }

  // Greedy subsequence: every query char must appear, in order.
  const indices: number[] = [];
  let ti = 0;
  for (const ch of q) {
    ti = t.indexOf(ch, ti);
    if (ti < 0) return null;
    indices.push(ti);
    ti++;
  }
  let gaps = 0;
  for (let i = 1; i < indices.length; i++) if (indices[i] !== indices[i - 1] + 1) gaps++;
  return { indices, score: 500 - gaps * 10 - indices[0] - text.length * 0.01 };
}

/** Rank `paths` against `query`; best match first, capped at `limit`. */
export function fuzzyFilter(query: string, paths: string[], limit = 500): { path: string; indices: number[] }[] {
  const out: { path: string; indices: number[]; score: number }[] = [];
  for (const p of paths) {
    const m = fuzzyMatch(query, p);
    if (m) out.push({ path: p, indices: m.indices, score: m.score });
  }
  out.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return out.slice(0, limit).map(({ path, indices }) => ({ path, indices }));
}
