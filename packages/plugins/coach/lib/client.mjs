// The worker's calls to the daemon (docs/plugins.md, "Assist" and "The worker"): its plugin key in
// the Authorization header. The web part's d.assist does not expose response headers, so the
// worker is the one that reads the budget headers and steps down before the daemon refuses.
import { budgetFromHeaders } from './judge.mjs';

/**
 * An assist function for the judge: `(req) => { result, budget, refused }`. `result` is the
 * daemon's answer or null; `budget` the X-Budget-* headers; `refused` the 429 budget body.
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
    } catch { return { result: null, budget: null, refused: null }; }
    const budget = budgetFromHeaders(res.headers);
    const body = await res.json().catch(() => null);
    if (res.ok) return { result: body && typeof body.text === 'string' ? body : null, budget, refused: null };
    if (res.status === 429 && body && body.error === 'budget') return { result: null, budget: budget || { usedPercent: body.usedPercent ?? null, capPercent: body.capPercent ?? null }, refused: body };
    return { result: null, budget, refused: null };
  };
}
