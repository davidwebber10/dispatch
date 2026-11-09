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

/**
 * The command palette's ranking (W1-G, 2026-11-09): a subsequence match of `needle` in `text`,
 * as one number. Higher is better; null means no match. Case does not matter, and white space in
 * the needle is ignored ("fix log" finds "Fix the login form").
 *
 * Each matched character scores 1, plus a bonus when it starts a word and a larger bonus when it
 * sits right after the previous matched character. So "log" ranks "Fix login" (a word start)
 * above "Catalog sync" (mid-word), and a run of characters above the same characters scattered.
 * The best placement is found (one pass per needle character), not the first one.
 */
const WORD_START_BONUS = 6;
const ADJACENT_BONUS = 8;
const GAP_PENALTY = 1;

function isWordStart(text: string, i: number): boolean {
  if (i === 0) return true;
  const prev = text[i - 1];
  if (/[\s\-_/.:·()[\]"'“”]/.test(prev)) return true;
  // camelCase: a capital after a lower-case letter.
  return /[a-z]/.test(prev) && /[A-Z]/.test(text[i]);
}

export function fuzzyScore(needle: string, text: string): number | null {
  const n = needle.toLowerCase().replace(/\s+/g, '');
  if (!n) return 0;
  const t = text.toLowerCase();
  if (n.length > t.length) return null;
  const NONE = -Infinity;
  // prev[j]: the best score with the previous needle character matched at text[j].
  let prev: number[] = new Array(t.length).fill(NONE);
  for (let i = 0; i < n.length; i++) {
    const cur: number[] = new Array(t.length).fill(NONE);
    let bestBefore = NONE; // the best of prev[0 .. j-2]: a match that is not adjacent
    for (let j = 0; j < t.length; j++) {
      if (j >= 2 && prev[j - 2] > bestBefore) bestBefore = prev[j - 2];
      if (t[j] !== n[i]) continue;
      const own = 1 + (isWordStart(text, j) ? WORD_START_BONUS : 0);
      if (i === 0) { cur[j] = own - Math.min(j, 20) * 0.05; continue; } // a small pull to the start
      const adjacent = j >= 1 && prev[j - 1] !== NONE ? prev[j - 1] + ADJACENT_BONUS : NONE;
      const gapped = bestBefore !== NONE ? bestBefore - GAP_PENALTY : NONE;
      const from = Math.max(adjacent, gapped);
      if (from !== NONE) cur[j] = from + own;
    }
    prev = cur;
  }
  let best = NONE;
  for (const v of prev) if (v > best) best = v;
  // A short text wins a tie: "Billing" before "New thread in Billing".
  return best === NONE ? null : best - Math.min(text.length, 200) * 0.01;
}
