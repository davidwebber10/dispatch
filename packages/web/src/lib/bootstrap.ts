// W2-H (remote launch latency): one request at launch, and one at a reconnect.
//
// At launch the app sent about 14 fixed GETs plus one thread list for each open project, and after a
// reconnect one thread list for EVERY project. A browser keeps six connections to a host, so on a
// 150 ms link that is three or more round trips before the lists are right. The daemon now gives the
// same data in one answer (`GET /api/bootstrap`, core routes/bootstrap.ts).
//
// How the answer reaches the stores: each store keeps its own loader, with its own rules (the thread
// list's epoch guard and auto-name check, the usage gauge's epoch and revision, the shared settings'
// first-save migration). This module does not copy those rules. While a bootstrap is in use, the read
// functions of `api` that it covers answer from the bootstrap in place of the network. A loader then
// runs exactly as before; only the round trip is gone. A part the daemon left out (`null`), an older
// daemon (404), or any failure: the read function makes its own request, as before.
//
// Freshness. A part is given to a caller only when the answer cannot be older than a request of its
// own would be allowed to be:
//  - At launch, to a call made before the events socket opened. Until then no event can have told the
//    app about a change, so no caller knows of anything newer. Calls made while the request is in
//    flight all get the part. For a short time after the answer (SERVE_AFTER_MS) the first call for
//    each part gets it too: on a first launch the lists mount only once the projects are known.
//  - After a reconnect, to the calls that `resyncAfterReconnect` itself makes, once each.
// Every other call goes to the network.
import { api } from '../api/client';
import { apiPath } from './basePath';
import { useConnection } from '../stores/connection';
import { useTabs } from '../stores/tabs';
import { useThreadStatus } from '../stores/threadStatus';
import type { Terminal } from '../api/types';

/** The answer of `GET /api/bootstrap`. A part is null when its own route did not give it to this caller. */
export interface BootstrapData {
  sessions?: unknown[] | null;
  terminalsByProject?: Record<string, unknown[]> | null;
  stalls?: unknown[] | null;
  authRequests?: unknown[] | null;
  update?: unknown;
  usageSummary?: unknown;
  sharedSettings?: { dictation?: unknown; coordinator?: unknown } | null;
  plugins?: unknown;
  schedules?: unknown[] | null;
}
export type BootstrapPart = 'sessions' | 'terminalsByProject' | 'stalls' | 'authRequests' | 'update' | 'usageSummary' | 'sharedSettings' | 'plugins' | 'schedules';

/** After the launch answer, the first call for each part still gets it for this long. */
export const SERVE_AFTER_MS = 1500;

type Reader = (...args: unknown[]) => Promise<unknown>;
/** The `api` reads the bootstrap covers: the key of a call (null: not covered, e.g. schedules of one project). */
const READS: Record<string, (args: unknown[]) => string | null> = {
  listSessions: () => 'sessions',
  listTerminals: (a) => (typeof a[0] === 'string' ? `terminals:${a[0]}` : null),
  listStalls: () => 'stalls',
  listAuthRequests: () => 'authRequests',
  getUpdateState: () => 'update',
  getUsageSummary: () => 'usageSummary',
  getDictationSettings: () => 'dictation',
  getCoordinatorSettings: () => 'coordinator',
  listSchedules: (a) => (a[0] === undefined ? 'schedules' : null),
};

const MISS = Symbol('miss');
/** The value for a key, or MISS when the answer does not hold it. */
function partOf(data: BootstrapData | null, key: string): unknown {
  if (!data) return MISS;
  let v: unknown;
  if (key.startsWith('terminals:')) v = data.terminalsByProject?.[key.slice('terminals:'.length)];
  else if (key === 'dictation') v = data.sharedSettings?.dictation;
  else if (key === 'coordinator') v = data.sharedSettings?.coordinator;
  else v = (data as Record<string, unknown>)[key];
  if (v === null || v === undefined) return MISS;
  if ((key === 'sessions' || key === 'stalls' || key === 'authRequests' || key === 'schedules' || key.startsWith('terminals:')) && !Array.isArray(v)) return MISS;
  return v;
}

/** Something that may answer a covered read. Returns undefined to let the next source, or the network, answer. */
interface Source { answer(key: string, network: () => Promise<unknown>): Promise<unknown> | undefined }
const sources: Source[] = [];
const originals = new Map<string, Reader>();
const table = api as unknown as Record<string, Reader>;

function install(): void {
  if (originals.size) return;
  for (const name of Object.keys(READS)) {
    const original = table[name];
    if (typeof original !== 'function') continue;
    originals.set(name, original);
    table[name] = (...args: unknown[]) => {
      const network = () => original(...args);
      const key = READS[name](args);
      if (key !== null) {
        for (const s of sources) {
          const hit = s.answer(key, network);
          if (hit !== undefined) return hit;
        }
      }
      return network();
    };
  }
}

function addSource(s: Source): void { sources.push(s); install(); }
function removeSource(s: Source): void {
  const i = sources.indexOf(s);
  if (i >= 0) sources.splice(i, 1);
  if (sources.length) return;
  // No bootstrap in use: `api` is exactly what it was.
  for (const [name, original] of originals) table[name] = original;
  originals.clear();
}

/** Fetch the bootstrap. Null for an older daemon (404), a refusal, a failure, or an answer that is not the bootstrap. */
export async function fetchBootstrap(parts?: BootstrapPart[]): Promise<BootstrapData | null> {
  try {
    const res = await fetch(apiPath(`/api/bootstrap${parts?.length ? `?parts=${parts.join(',')}` : ''}`));
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    // An older daemon can answer an unknown path with something else. The bootstrap is a plain object.
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    return body as BootstrapData;
  } catch { return null; }
}

let launch: Promise<boolean> | null = null;

/**
 * Start the launch bootstrap (once for each page load). Call it before the first render, so the calls
 * that the first effects make are covered. Resolves true when the daemon gave a bootstrap.
 */
export function loadBootstrap(): Promise<boolean> {
  if (launch) return launch;
  const seen = new Set<string>();          // every covered call made since the start, served or not
  const servedAfter = new Set<string>();   // parts already given to a call made after the answer
  let data: BootstrapData | null = null;
  let settledAt = 0;
  const socketOpened = () => useConnection.getState().everOpen;
  const request = fetchBootstrap();

  const source: Source = {
    answer(key, network) {
      seen.add(key);
      if (socketOpened()) return undefined; // an event may already have told the caller of something newer
      if (!settledAt) {
        return request.then((d) => {
          const v = partOf(d, key);
          return v === MISS ? network() : v;
        });
      }
      if (Date.now() - settledAt > SERVE_AFTER_MS || servedAfter.has(key)) return undefined;
      const v = partOf(data, key);
      if (v === MISS) return undefined;
      servedAfter.add(key);
      return Promise.resolve(v);
    },
  };
  addSource(source);

  launch = request.then((d) => {
    data = d;
    settledAt = Date.now();
    if (!d) { removeSource(source); return false; }
    fillUnasked(d, seen, socketOpened());
    setTimeout(() => removeSource(source), SERVE_AFTER_MS);
    return true;
  });
  return launch;
}

/**
 * Put the parts that no loader asked for straight into their stores: the thread lists of the projects
 * whose card is closed (their counts are then right at once, and a card opens with its list), and the
 * stall flags. A part that any call asked for since the bootstrap started is left to that call: its
 * answer is this same data, or newer data from the network. With the events socket open, nothing is
 * put: an event-driven load may hold newer data than this answer.
 */
function fillUnasked(d: BootstrapData, seen: Set<string>, socketOpen: boolean): void {
  if (socketOpen) return;
  const lists = d.terminalsByProject;
  if (lists && typeof lists === 'object') {
    const byProject = { ...useTabs.getState().byProject };
    const tabSession = { ...useTabs.getState().tabSession };
    let changed = false;
    for (const [projectId, list] of Object.entries(lists)) {
      if (seen.has(`terminals:${projectId}`) || !Array.isArray(list)) continue;
      byProject[projectId] = list as Terminal[];
      for (const t of list as Terminal[]) if (t && typeof t.id === 'string') tabSession[t.id] = projectId;
      changed = true;
    }
    if (changed) useTabs.setState({ byProject, tabSession });
  }
  if (!seen.has('stalls') && Array.isArray(d.stalls)) {
    const stalls: Record<string, number> = {};
    for (const s of d.stalls as { terminalId?: unknown; stalledSince?: unknown }[]) {
      if (typeof s?.terminalId === 'string' && typeof s.stalledSince === 'number') stalls[s.terminalId] = s.stalledSince;
    }
    useThreadStatus.setState({ stalls });
  }
}

/**
 * A reconnect: fetch the named parts in one request, then run `loads` with that answer in front of the
 * network. Each covered read that `loads` makes gets its part once. A part the answer lacks, and any
 * second call, goes to the network; so does everything when the daemon has no bootstrap.
 *
 * A part that some other call asked for WHILE the request was in flight is not given: that call was
 * made after an event (the socket is open now), and it can hold newer data than this answer. The load
 * for that part then makes its own request, later than that call, as it did before W2-H.
 */
export async function resyncWithBootstrap<T>(parts: BootstrapPart[], loads: () => Promise<T>): Promise<T> {
  const asked = new Set<string>();
  const watch: Source = { answer(key) { asked.add(key); return undefined; } };
  sources.unshift(watch);
  install();
  let data: BootstrapData | null;
  try { data = await fetchBootstrap(parts); } finally { removeSource(watch); }
  if (!data) return loads();
  const served = new Set<string>();
  const source: Source = {
    answer(key) {
      if (served.has(key) || asked.has(key)) return undefined;
      const v = partOf(data, key);
      if (v === MISS) return undefined;
      served.add(key);
      return Promise.resolve(v);
    },
  };
  // In front of a launch source that is still there: this answer is the newer one.
  sources.unshift(source);
  install();
  // The loaders call their reads at once, in this same turn; the source is needed no longer than that.
  try { return await loads(); } finally { removeSource(source); }
}

/** Test hook: forget the launch bootstrap and put `api` back. */
export function resetBootstrapForTest(): void {
  launch = null;
  sources.length = 0;
  for (const [name, original] of originals) table[name] = original;
  originals.clear();
}
