// The worker's calls to the daemon (docs/plugins.md, "Assist" and "The worker"): its plugin key in
// the Authorization header. The web part's d.assist does not expose response headers, so the
// worker is the one that reads the budget headers and steps down before the daemon refuses.
import { budgetFromHeaders } from './judge.mjs';

/** Answers that say "not now" rather than "no": too many calls at once, no model signed in, no answer (a timeout). */
const TRANSIENT = new Set([429, 502, 503, 504]);

/**
 * An assist function for the judge: `(req) => { result, budget, refused, transient }`. `result` is
 * the daemon's answer or null; `budget` the X-Budget-* headers; `refused` the 429 budget body;
 * `transient` a passing failure (429 busy, 502, 503, a network error, a timeout): try again later.
 */
export function makeAssist({ fetch, api, plugin, key, timeoutMs = 120_000 }) {
  return async (req) => {
    let res;
    try {
      res = await fetch(`${api}/api/plugins/${encodeURIComponent(plugin)}/assist`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key()}`, 'content-type': 'application/json' },
        body: JSON.stringify(req),
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
      });
    } catch { return { result: null, budget: null, refused: null, transient: true }; }
    const budget = budgetFromHeaders(res.headers);
    const body = await res.json().catch(() => null);
    if (res.ok) return { result: body && typeof body.text === 'string' ? body : null, budget, refused: null };
    if (res.status === 429 && body && body.error === 'budget') return { result: null, budget: budget || { usedPercent: body.usedPercent ?? null, capPercent: body.capPercent ?? null }, refused: body };
    return { result: null, budget, refused: null, transient: TRANSIENT.has(res.status) };
  };
}
