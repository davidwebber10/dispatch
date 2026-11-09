// packages/core/src/routes/bootstrap.ts
// W2-H (remote launch latency): the launch calls of the web page in one answer.
//
// At launch the page sent about 14 fixed GETs plus one thread list for each project. On a 150 ms link,
// with six connections for each host, that is three or more round trips before the lists are complete.
// `GET /api/bootstrap` gives the same data in one round trip.
//
// The safety rule: the route reads no service and no table. Each part is the answer of its OWN route,
// asked inside the daemon as the SAME caller (same socket, same credential headers). The policy handler,
// the key rule and the redaction of that route all run. A part that its route refuses, does not have,
// or fails on is `null`, and the client then asks the route itself, as it did before. So the bootstrap
// can never hold more than the caller gets from the routes one by one.
// A route that marks its answer `Cache-Control: no-store` says "do not keep this, do not compress this"
// (http/compress.ts sends such an answer as-is: a compressed secret leaks its length). The bootstrap is
// compressed, so that part is `null` too. Today that is the plugin list (routes/plugins.ts).
// The route is owner only: a thread, Chat, shell or plugin key gets 403 before any part is read.
import http from 'node:http';
import type { Express, Request, Router } from 'express';
import { ownerOnly, policyRouter } from '../auth/route-policy.js';

/** The parts of the answer, in the order of the plan (section 4A). */
export const BOOTSTRAP_PARTS = ['sessions', 'terminalsByProject', 'stalls', 'authRequests', 'update', 'usageSummary', 'sharedSettings', 'plugins', 'schedules'] as const;
export type BootstrapPart = typeof BOOTSTRAP_PARTS[number];

/** The route behind each part that is one GET. */
const SIMPLE: Partial<Record<BootstrapPart, string>> = {
  stalls: '/api/terminals/stalls',
  authRequests: '/api/auth-requests',
  update: '/api/state/update',
  usageSummary: '/api/usage-limits/summary',
  plugins: '/api/plugins',
  schedules: '/api/agents/schedules',
};

/** Request headers that belong to the outer call only: its body, its cache check, its encoding. */
const NOT_CARRIED = new Set(['accept-encoding', 'if-none-match', 'if-modified-since', 'if-match', 'if-unmodified-since', 'if-range', 'range', 'content-length', 'content-type', 'transfer-encoding', 'expect']);
/** An inner call that does not answer in this time counts as failed (its part is null). */
const INNER_TIMEOUT_MS = 10_000;

export interface InnerAnswer { status: number; body: unknown; noStore: boolean }

/**
 * Ask one GET route of `app` as the caller of `req`, without the network. The inner request is a new
 * message on the same socket with the same headers (less the ones in NOT_CARRIED), so the access gate
 * and the principal middleware see the same caller and decide again. Marks that Dispatch middleware
 * put on the outer request (`Symbol('dispatch.…')`: the gate's decision) are carried too, for an app
 * whose gate runs before this one.
 */
export function innerGet(app: Express, req: Request, path: string): Promise<InnerAnswer> {
  return new Promise<InnerAnswer>((resolve) => {
    const inner = new http.IncomingMessage(req.socket);
    inner.method = 'GET';
    inner.url = path;
    inner.httpVersion = req.httpVersion;
    inner.httpVersionMajor = req.httpVersionMajor;
    inner.httpVersionMinor = req.httpVersionMinor;
    const headers: http.IncomingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) if (!NOT_CARRIED.has(k)) headers[k] = v;
    inner.headers = headers;
    const marks = inner as unknown as Record<symbol, unknown>;
    for (const s of Object.getOwnPropertySymbols(req)) {
      if (s.description?.startsWith('dispatch.')) marks[s] = (req as unknown as Record<symbol, unknown>)[s];
    }
    // No body: the stream ends at once (a handler that waits for the end of the request must not hang).
    inner.complete = true;
    inner.push(null);

    const res = new http.ServerResponse(inner);
    const chunks: Buffer[] = [];
    let done = false;
    const finish = (answer: InnerAnswer) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(answer);
    };
    const timer = setTimeout(() => finish({ status: 504, body: null, noStore: false }), INNER_TIMEOUT_MS);
    const take = (chunk: unknown, encoding?: unknown) => {
      if (typeof chunk === 'string') chunks.push(Buffer.from(chunk, typeof encoding === 'string' ? encoding as BufferEncoding : 'utf8'));
      else if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk));
    };
    // The answer never reaches a socket: keep the bytes, and settle when the handler ends it.
    res.write = ((chunk: unknown, encoding?: unknown, cb?: unknown) => {
      take(chunk, encoding);
      const fn = typeof encoding === 'function' ? encoding : cb;
      if (typeof fn === 'function') queueMicrotask(fn as () => void);
      return true;
    }) as typeof res.write;
    res.end = ((chunk?: unknown, encoding?: unknown, cb?: unknown) => {
      if (typeof chunk !== 'function') take(chunk, encoding);
      let body: unknown = null;
      // Only a plain JSON answer is a part. An encoded one cannot happen (no Accept-Encoding was sent).
      if (!res.getHeader('Content-Encoding')) {
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
      }
      finish({ status: res.statusCode, body, noStore: /\bno-store\b/i.test(String(res.getHeader('Cache-Control') ?? '')) });
      const fn = [chunk, encoding, cb].find((x) => typeof x === 'function');
      if (typeof fn === 'function') queueMicrotask(fn as () => void);
      return res;
    }) as typeof res.end;

    try {
      (app as unknown as (q: http.IncomingMessage, s: http.ServerResponse, next: (err?: unknown) => void) => void)(inner, res, () => finish({ status: 404, body: null, noStore: false }));
    } catch {
      finish({ status: 500, body: null, noStore: false });
    }
  });
}

/** `?parts=a,b`: the named parts only (a reconnect asks for three). Absent: all. An unknown name is ignored. */
function wanted(req: Request): Set<BootstrapPart> {
  const raw = typeof req.query.parts === 'string' ? req.query.parts : '';
  if (!raw) return new Set(BOOTSTRAP_PARTS);
  const names = raw.split(',').map((s) => s.trim());
  return new Set(BOOTSTRAP_PARTS.filter((p) => names.includes(p)));
}

/** `app` is the daemon's own Express app: the parts are read through its routes. */
export function createBootstrapRouter(app: Express): Router {
  const router = policyRouter();

  router.get('/', ownerOnly, async (req, res) => {
    const want = wanted(req);
    const ok = async (path: string): Promise<unknown> => {
      const a = await innerGet(app, req, path);
      // Not 200: refused, absent or failed. no-store: the route does not let its answer be kept or compressed.
      if (a.status !== 200 || a.body === null || a.noStore) return null;
      return a.body;
    };
    const out: Partial<Record<BootstrapPart, unknown>> = {};
    const jobs: Promise<void>[] = [];

    if (want.has('sessions') || want.has('terminalsByProject')) {
      jobs.push((async () => {
        const sessions = await ok('/api/sessions');
        if (want.has('sessions')) out.sessions = sessions;
        if (!want.has('terminalsByProject')) return;
        // One thread list for each project the caller can list. A project whose list is refused is left out.
        const byProject: Record<string, unknown> = {};
        const ids = Array.isArray(sessions) ? sessions.map((s) => (s as { id?: unknown })?.id).filter((id): id is string => typeof id === 'string') : [];
        await Promise.all(ids.map(async (id) => {
          const list = await ok(`/api/sessions/${encodeURIComponent(id)}/terminals`);
          if (Array.isArray(list)) byProject[id] = list;
        }));
        // The order of the project list, whatever order the lists came back in.
        out.terminalsByProject = Object.fromEntries(ids.filter((id) => id in byProject).map((id) => [id, byProject[id]]));
      })());
    }
    for (const part of BOOTSTRAP_PARTS) {
      const path = SIMPLE[part];
      if (path && want.has(part)) jobs.push(ok(path).then((body) => { out[part] = body; }));
    }
    if (want.has('sharedSettings')) {
      jobs.push(Promise.all([ok('/api/settings/dictation'), ok('/api/settings/coordinator')]).then(([dictation, coordinator]) => {
        out.sharedSettings = { dictation, coordinator };
      }));
    }

    await Promise.all(jobs);
    // Always checked with the daemon (the ETag gives a 304 when nothing changed); never served from a cache alone.
    res.setHeader('Cache-Control', 'no-cache');
    // The key order of the plan, so two answers with the same data are the same bytes (the ETag then matches).
    res.json(Object.fromEntries(BOOTSTRAP_PARTS.filter((p) => p in out).map((p) => [p, out[p] ?? null])));
  });

  return router;
}
