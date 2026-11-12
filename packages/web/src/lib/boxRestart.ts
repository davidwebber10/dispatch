// The web client through a restart of a hosted box (box <-> OS contract 2026-11-11, "Router behaviour").
//
// While a box is not ready, the OS router answers an API call with 503 JSON `{error, state}` (or a 502
// /504 from the load balancer), a browser navigation with a 302 to the OS launcher (`/dispatch`, an
// HTML page), and a WebSocket with 503. None of that is an error the person should see, and the
// launcher HTML must never be parsed as data. So:
//   • an answer that looks like that marks the box "down": a quiet "Reconnecting…" pill, no error wall;
//   • one poll (every 2 s, redirects NOT followed) asks the box's own /api/whoami;
//   • when the box answers JSON again, the page reloads ONCE, at the base path WITH the slash
//     (`/dispatch/`: the exact `/dispatch` belongs to the OS launcher). Composer drafts live in
//     localStorage, so a reload keeps typed text.
// A local daemon never answers this way (its own 503s carry no `state`), so nothing changes there.
import { create } from 'zustand';
import { BASE, apiPath } from './basePath';

export const useBoxRestart = create<{ down: boolean }>(() => ({ down: false }));

const POLL_MS = 2000;
let polling = false;

/** True when an /api answer is the router's "box not ready", not the daemon's own answer. */
export async function isBoxDownAnswer(res: Response): Promise<boolean> {
  if (res.type === 'opaqueredirect' || res.redirected) return true;
  const type = res.headers?.get?.('content-type') ?? '';
  if (/text\/html/i.test(type)) return true; // the launcher page, reached through a followed 302
  if (res.status === 502 || res.status === 504) return true;
  if (res.status !== 503) return false;
  try {
    const body = await (res.clone ? res.clone() : res).json();
    return !!body && typeof body === 'object' && 'state' in body;
  } catch {
    return true; // a 503 that is not the daemon's JSON
  }
}

/**
 * The router's 409 (contract: the profile rule failed → `{error, reason: "update-needed"}`; a legacy
 * `/u/<slug>` box rebuilt to `/dispatch` → `{error, location: "/dispatch/"}`): where the page must go
 * by a full navigation, where the router answers with its redirect (the OS launcher's "needs an
 * update" page, or the new address). Null for any other answer, including the daemon's own 409s.
 */
export async function routerConflictTarget(res: Response): Promise<string | null> {
  if (res.status !== 409) return null;
  try {
    const body = await (res.clone ? res.clone() : res).json();
    if (!body || typeof body !== 'object') return null;
    if (body.reason === 'update-needed') return reloadTarget();
    if (typeof body.location === 'string' && body.location.startsWith('/') && !body.location.startsWith('//')) return body.location;
  } catch { /* not JSON: not the router's 409 */ }
  return null;
}

let leaving = false;
/** Leave the page once for the router's address (routerConflictTarget). */
export function leaveFor(target: string, go: (url: string) => void = (url) => location.replace(url)): void {
  if (leaving) return;
  leaving = true;
  useBoxRestart.setState({ down: true });
  go(target);
}

/**
 * The events socket keeps failing to open (the router answers a WebSocket with 503/409, which the
 * browser shows only as a close). Ask the box once over HTTP, redirects not followed: the router's
 * "not ready" starts the quiet reconnect, its 409 leaves for the router's address. A plain network
 * error (a local daemon restarting) does nothing: the socket's own retry brings it back.
 */
export async function probeBox(opts: { fetchImpl?: typeof fetch; go?: (url: string) => void; reload?: (url: string) => void; pollMs?: number } = {}): Promise<void> {
  if (!BASE) return;
  try {
    const res = await (opts.fetchImpl ?? fetch)(apiPath('/api/whoami'), { redirect: 'manual', cache: 'no-store' });
    const target = await routerConflictTarget(res);
    if (target) { leaveFor(target, opts.go); return; }
    if (await isBoxDownAnswer(res)) noteBoxDown({ fetchImpl: opts.fetchImpl, reload: opts.reload, pollMs: opts.pollMs });
  } catch { /* offline, or the daemon itself is restarting: the socket retries */ }
}

/** The page the reload goes to: the base path with its trailing slash, never the bare `/dispatch`. */
export function reloadTarget(): string {
  return `${BASE}/`;
}

export function noteBoxDown(opts: { fetchImpl?: typeof fetch; reload?: (url: string) => void; pollMs?: number } = {}): void {
  useBoxRestart.setState({ down: true });
  if (polling) return;
  polling = true;
  const f = opts.fetchImpl ?? fetch;
  const reload = opts.reload ?? ((url: string) => location.replace(url));
  const tick = async () => {
    try {
      const res = await f(apiPath('/api/whoami'), { redirect: 'manual', cache: 'no-store' });
      const json = /application\/json/i.test(res.headers?.get?.('content-type') ?? '');
      if (res.ok && json && !res.redirected) { polling = false; reload(reloadTarget()); return; }
    } catch { /* still down */ }
    setTimeout(() => { void tick(); }, opts.pollMs ?? POLL_MS);
  };
  setTimeout(() => { void tick(); }, opts.pollMs ?? POLL_MS);
}

/** Test seam. */
export function resetBoxRestart(): void { polling = false; leaving = false; useBoxRestart.setState({ down: false }); }
