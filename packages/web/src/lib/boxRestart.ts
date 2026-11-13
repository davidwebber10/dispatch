// The web client through a restart of a hosted workspace (box <-> OS contract 2026-11-11, "Router behaviour").
//
// While the workspace is not ready, the OS router answers an API call with 503 JSON `{error, state}`
// (or a 502/504 from the load balancer), a browser PAGE LOAD with a 302 to the OS launcher (`/dispatch`,
// an HTML page that is not Dispatch), and a WebSocket with 503. A restart takes about two minutes, and
// the person must not see it (product rule: a pause or a restart is transparent). So:
//   • an answer that looks like that marks the workspace "down": a quiet "Reconnecting…" pill, no
//     error wall, and the page stays where it is. It NEVER navigates or reloads while down: a page
//     load in that window goes to the launcher, which is the defect of 2026-11-11 (the old code
//     reloaded on the first JSON answer, which could still come from the process that was stopping);
//   • a probe asks the daemon's own `/api/host-context` (redirects not followed, no cache, JSON
//     asked for), with a backoff from 1.5 s to 5 s and no time limit. Only a 200 JSON answer in the
//     daemon's shape is "back"; a redirect, the launcher HTML, a 401/409/502/503 are "not back";
//   • back: the page's build is compared with the shell the daemon serves now (the content-hashed
//     entry script, the same build id main.tsx's update watch uses). Same build: the sockets
//     reconnect and the state reloads in place (no page load; drafts, tabs and the grid stay). A new
//     build (a new image): ONE reload, only after the shell itself answered 200 HTML, so the page load
//     cannot land on the launcher;
//   • after 3 minutes one plain line under the pill says that this takes longer than usual.
// A local daemon never answers this way (its own 503s carry no `state`), and all of this runs only
// under a base path, so a local install keeps its own reconnect (the sockets' retry) unchanged.
import { create } from 'zustand';
import { BASE, apiPath } from './basePath';
import { dropSavedShell } from './shellCache';

export const useBoxRestart = create<{ down: boolean; slow: boolean }>(() => ({ down: false, slow: false }));

/** True while the workspace is down: nothing may reload or navigate the page (signInReload, main.tsx). */
export function isBoxDown(): boolean {
  return useBoxRestart.getState().down;
}

export const PROBE_FIRST_MS = 1500;
export const PROBE_MAX_MS = 5000;
/** After this long the pill adds one plain line. There is no time limit on the wait itself. */
export const SLOW_AFTER_MS = 3 * 60_000;

/** True when an /api answer is the router's "not ready", not the daemon's own answer. */
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
 * True only for the daemon's own host-context answer: 200, not a redirect (followed or opaque), JSON
 * content, and the daemon's shape (`hosted` boolean, `capabilities` list). The router's JSON (`{error,
 * state}`) has neither, so a router answer can never pass as "back".
 */
export async function isDaemonBackAnswer(res: Response): Promise<boolean> {
  if (res.type === 'opaqueredirect' || res.redirected || res.status !== 200) return false;
  if (!/application\/json/i.test(res.headers?.get?.('content-type') ?? '')) return false;
  try {
    const body = await (res.clone ? res.clone() : res).json();
    return !!body && typeof body === 'object' && typeof body.hosted === 'boolean' && Array.isArray(body.capabilities);
  } catch {
    return false;
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

export interface WaitOpts {
  fetchImpl?: typeof fetch;
  /** The one reload for a new build. Default: drop the saved shell, then load the page's own address. */
  reload?: (url: string) => void;
  /** The entry script this page runs (default: from the document). */
  currentEntry?: () => string | null;
}

/**
 * The events socket keeps failing to open (the router answers a WebSocket with 503/409, which the
 * browser shows only as a close). Ask the daemon once over HTTP, redirects not followed: the router's
 * "not ready" starts the quiet wait, its 409 leaves for the router's address. A plain network error
 * (a local daemon restarting) does nothing: the socket's own retry brings it back.
 */
export async function probeBox(opts: WaitOpts & { go?: (url: string) => void } = {}): Promise<void> {
  if (!BASE) return;
  try {
    const res = await (opts.fetchImpl ?? fetch)(apiPath('/api/whoami'), { redirect: 'manual', cache: 'no-store' });
    const target = await routerConflictTarget(res);
    if (target) { leaveFor(target, opts.go); return; }
    if (await isBoxDownAnswer(res)) noteBoxDown(opts);
  } catch { /* offline, or the daemon itself is restarting: the socket retries */ }
}

/** The base path with its trailing slash, never the bare `/dispatch` (that address is the OS launcher). */
export function reloadTarget(): string {
  return `${BASE}/`;
}

/** The page's own address when it is under the base path, else the base path with its slash. */
function ownAddress(): string {
  try {
    if (location.pathname.startsWith(`${BASE}/`)) return location.pathname + location.search + location.hash;
  } catch { /* no location */ }
  return reloadTarget();
}

/** The entry script a shell names, as an absolute address. Mirrors main.tsx's update watch. */
export function entryOfShell(html: string, baseUri: string = typeof document !== 'undefined' ? document.baseURI : 'http://localhost/'): string | null {
  const m = html.match(/<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]+)"/);
  try { return m ? new URL(m[1], baseUri).href : null; } catch { return null; }
}

function documentEntry(): string | null {
  try {
    return (document.querySelector('script[type="module"][src*="/assets/"]') as HTMLScriptElement | null)?.src ?? null;
  } catch { return null; }
}

// What the page does when the daemon is back on the same build: App.tsx sets it (new sockets for
// events, chats and terminals; the events socket's reopen then reloads the state in place).
let onBack: () => void = () => {};
export function setBoxBackHandler(fn: () => void): () => void {
  onBack = fn;
  return () => { if (onBack === fn) onBack = () => {}; };
}

let waiting = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let slowTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * One probe. 'down': not back yet. 'same': back on this page's build. 'new': back on another build,
 * and its shell answers 200 HTML (a page load is safe now).
 */
export async function probeOnce(opts: WaitOpts = {}): Promise<'down' | 'same' | 'new'> {
  const f = opts.fetchImpl ?? fetch;
  try {
    const res = await f(apiPath('/api/host-context'), { redirect: 'manual', cache: 'no-store', headers: { Accept: 'application/json' } });
    if (!(await isDaemonBackAnswer(res))) return 'down';
    const current = (opts.currentEntry ?? documentEntry)();
    if (!current) return 'same'; // a development page has no content-hashed entry: nothing to compare
    const shell = await f(reloadTarget(), { redirect: 'manual', cache: 'no-store', headers: { Accept: 'text/html' } });
    if (shell.type === 'opaqueredirect' || shell.redirected || shell.status !== 200) return 'down';
    if (!/text\/html/i.test(shell.headers?.get?.('content-type') ?? '')) return 'down';
    const entry = entryOfShell(await shell.text());
    return entry && entry !== current ? 'new' : 'same';
  } catch {
    return 'down';
  }
}

/** The workspace is down: show the quiet state and wait for it, however long it takes. */
export function noteBoxDown(opts: WaitOpts = {}): void {
  if (!useBoxRestart.getState().down) useBoxRestart.setState({ down: true, slow: false });
  if (waiting) return;
  waiting = true;
  clearTimeout(slowTimer);
  slowTimer = setTimeout(() => { if (waiting) useBoxRestart.setState({ slow: true }); }, SLOW_AFTER_MS);
  let delay = PROBE_FIRST_MS;
  const tick = async () => {
    const result = await probeOnce(opts);
    if (!waiting) return;
    if (result === 'down') {
      delay = Math.min(Math.round(delay * 1.5), PROBE_MAX_MS);
      timer = setTimeout(() => { void tick(); }, delay);
      return;
    }
    waiting = false;
    clearTimeout(slowTimer);
    if (result === 'new') {
      // A new image: one reload, from the network (the saved shell is the old build).
      const reload = opts.reload ?? ((url: string) => { void dropSavedShell().then(() => location.replace(url)); });
      reload(ownAddress());
      return;
    }
    useBoxRestart.setState({ down: false, slow: false });
    try { onBack(); } catch { /* the sockets retry by themselves */ }
  };
  timer = setTimeout(() => { void tick(); }, delay);
}

/** Test seam. */
export function resetBoxRestart(): void {
  waiting = false; leaving = false;
  clearTimeout(timer); clearTimeout(slowTimer);
  onBack = () => {};
  useBoxRestart.setState({ down: false, slow: false });
}
