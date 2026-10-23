import type { Request } from 'express';

/**
 * Stage 1 counts of requests that carry no credential (spec 6.9). In stage 1 the owner's browser
 * has no cookie, so every browser request lands here; a log line per request would flood the log.
 * The counts are complete. Log lines are rate limited: the first request of each
 * (category, method, path pattern) per daemon start, then one summary line per hour.
 */
export type NoCredentialCategory = 'browser' | 'program';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_ID = /^(?=.*\d)[A-Za-z0-9_-]{20,}$/;
const HOUR_MS = 60 * 60_000;
const MAX_PATTERNS = 500;
const TOP = 20;

/** Replace each UUID-like segment, and each id-like segment of 20 or more characters with a digit, by :id. */
export function pathPattern(p: string): string {
  return p.split('/').map((seg) => (UUID.test(seg) || LONG_ID.test(seg) ? ':id' : seg)).join('/');
}

export interface CategoryCounts { total: number; top: { pattern: string; count: number }[] }
export interface NoCredentialSnapshot { since: number; browser: CategoryCounts; program: CategoryCounts }

export interface NoCredentialStats {
  record(req: Pick<Request, 'method' | 'path' | 'headers'>): void;
  snapshot(): NoCredentialSnapshot;
}

export function createNoCredentialStats(opts: { log?: (line: string) => void; now?: () => number }): NoCredentialStats {
  const log = opts.log ?? ((l: string) => console.log(l));
  const now = opts.now ?? Date.now;
  const since = now();
  let lastSummary = since;
  let sinceSummary = { browser: 0, program: 0 };
  const counts: Record<NoCredentialCategory, Map<string, number>> = { browser: new Map(), program: new Map() };
  const totals = { browser: 0, program: 0 };

  return {
    record(req) {
      const category: NoCredentialCategory = req.headers['sec-fetch-mode'] !== undefined ? 'browser' : 'program';
      let pattern = `${req.method} ${pathPattern(req.path)}`;
      const map = counts[category];
      if (!map.has(pattern) && map.size >= MAX_PATTERNS) pattern = 'other';
      const first = !map.has(pattern);
      map.set(pattern, (map.get(pattern) ?? 0) + 1);
      totals[category]++;
      sinceSummary[category]++;
      if (first) {
        const ua = String(req.headers['user-agent'] ?? '').replace(/[\r\n]+/g, ' ').slice(0, 80);
        log(`[keys] no-credential ${category} ${pattern} UA=${ua}`);
      }
      const t = now();
      if (t - lastSummary >= HOUR_MS) {
        log(`[keys] no-credential summary: browser ${sinceSummary.browser}, program ${sinceSummary.program} in the last hour; totals browser ${totals.browser}, program ${totals.program}`);
        lastSummary = t;
        sinceSummary = { browser: 0, program: 0 };
      }
    },
    snapshot() {
      const cat = (c: NoCredentialCategory): CategoryCounts => ({
        total: totals[c],
        top: [...counts[c].entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP).map(([pattern, count]) => ({ pattern, count })),
      });
      return { since, browser: cat('browser'), program: cat('program') };
    },
  };
}
