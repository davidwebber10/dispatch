import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Request, RequestHandler } from 'express';
import { GATE_VIA, ownerCredentialKind } from './access-gate.js';
import { BOX_TOKEN_HEADER, tokenMatches } from './box-token.js';
import { bearerKey, type KeyPrincipal, type KeyRegistry } from './principals.js';
import type { KeyScope } from './key-scope.js';
import type { NoCredentialStats } from './no-credential-stats.js';

export { bearerKey } from './principals.js';

/**
 * Attaches one principal to every request (spec 6.4). A request that carries a key is judged as
 * the key, whatever other credential it also carries.
 */
export type Principal =
  | KeyPrincipal
  | { kind: 'owner'; via: 'cookie' | 'token' | 'box' }
  | { kind: 'none'; via: 'local' | 'tailscale' | 'test' };

const PRINCIPAL = Symbol('dispatch.principal');
const SCOPE = Symbol('dispatch.keyScope');
type Tagged = Record<symbol, unknown>;

export function principalOf(req: Request): Principal {
  const p = (req as unknown as Tagged)[PRINCIPAL] as Principal | undefined;
  if (!p) throw new Error('principalOf called before the principal middleware ran');
  return p;
}

export function scopeOf(req: Request): KeyScope {
  const s = (req as unknown as Tagged)[SCOPE] as KeyScope | undefined;
  if (!s) throw new Error('scopeOf called before the principal middleware ran');
  return s;
}

const INVALID_KEY_MESSAGE = 'This Dispatch key is not valid any more. Start a new thread.';
const REFUSAL_WINDOW_MS = 60_000;

/** Rate-limited refusal lines: the first per key hash, then one per minute with a count. Never the key. */
function createRefusalLog(log: (line: string) => void, now: () => number) {
  const seen = new Map<string, { last: number; suppressed: number }>();
  return (key: string, method: string, p: string) => {
    const id = crypto.createHash('sha256').update(key).digest('hex').slice(0, 8);
    const t = now();
    const e = seen.get(id);
    if (!e) {
      if (seen.size > 1000) seen.clear();
      seen.set(id, { last: t, suppressed: 0 });
      log(`[keys] refused unknown or revoked key ${id} ${method} ${p}`);
      return;
    }
    if (t - e.last >= REFUSAL_WINDOW_MS) {
      log(`[keys] refused unknown or revoked key ${id} ${method} ${p} (${e.suppressed + 1} more)`);
      e.last = t;
      e.suppressed = 0;
    } else {
      e.suppressed++;
    }
  };
}

export interface PrincipalOptions {
  registry: KeyRegistry;
  scope: KeyScope;
  /** Current access token, or null. Absent in createApp. */
  getToken?: () => string | null;
  boxToken?: string;
  stats?: NoCredentialStats;
  log?: (line: string) => void;
  now?: () => number;
  /** How a credential-free request is labelled when the access gate did not run. Default 'test'. */
  via?: 'test';
}

const isApiPath = (p: string) => p.toLowerCase().startsWith('/api/');
const isLoginPath = (req: Request) => req.method === 'POST' && req.path.toLowerCase() === '/api/access/login';

function headerOf(req: Pick<Request, 'headers'>, name: string): string | undefined {
  const raw = req.headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

export function createPrincipalMiddleware(opts: PrincipalOptions): RequestHandler {
  const log = opts.log ?? ((l: string) => console.log(l));
  const now = opts.now ?? Date.now;
  const refusal = createRefusalLog(log, now);
  return (req, res, next) => {
    (req as unknown as Tagged)[SCOPE] = opts.scope;
    const set = (p: Principal) => { (req as unknown as Tagged)[PRINCIPAL] = p; next(); };
    const auth = headerOf(req, 'authorization');
    const key = bearerKey(auth);
    if (key !== null) {
      const principal = opts.registry.resolve(key);
      if (!principal) {
        refusal(key, req.method, req.path);
        return void res.status(401).json({ error: 'auth_required', message: INVALID_KEY_MESSAGE });
      }
      if (!isApiPath(req.path) || isLoginPath(req)) {
        return void res.status(403).json({ error: 'owner_only', message: 'A thread key cannot use this route. Ask the owner.' });
      }
      return set(principal);
    }
    if (opts.boxToken && tokenMatches(opts.boxToken, headerOf(req, BOX_TOKEN_HEADER))) {
      return set({ kind: 'owner', via: 'box' });
    }
    const token = opts.getToken?.() ?? null;
    if (token) {
      const kind = ownerCredentialKind(auth, headerOf(req, 'cookie'), token);
      if (kind) return set({ kind: 'owner', via: kind });
    }
    const gateVia = (req as unknown as Tagged)[GATE_VIA];
    if (gateVia === 'local' || gateVia === 'tailscale') {
      if (gateVia === 'local') opts.stats?.record(req);
      return set({ kind: 'none', via: gateVia });
    }
    return set({ kind: 'none', via: opts.via ?? 'test' });
  };
}

/**
 * Mount on `POST /api/access/login`, before the access gate (the gate has no login exemption).
 * A live key gets 403 and no cookie; a revoked key gets 401; no key goes on unchanged.
 */
export function createLoginKeyCheck(opts: {
  registry: KeyRegistry; log?: (line: string) => void; now?: () => number;
}): RequestHandler {
  const refusal = createRefusalLog(opts.log ?? ((l: string) => console.log(l)), opts.now ?? Date.now);
  return (req, res, next) => {
    const key = bearerKey(headerOf(req, 'authorization'));
    if (key === null) return next();
    res.setHeader('Cache-Control', 'no-store');
    if (!opts.registry.resolve(key)) {
      refusal(key, req.method, req.path);
      return void res.status(401).json({ error: 'auth_required', message: INVALID_KEY_MESSAGE });
    }
    res.status(403).json({ error: 'owner_only', message: 'A thread key cannot sign in. Ask the owner.' });
  };
}

/** True when a WebSocket upgrade carries a key. Every such upgrade is refused (spec 6.4). */
export function refuseKeyUpgrade(req: Pick<IncomingMessage, 'headers'>): boolean {
  return bearerKey(headerOf(req as Pick<Request, 'headers'>, 'authorization')) !== null;
}

/** GET /api/whoami: any principal. */
export const whoamiHandler: RequestHandler = (req, res) => {
  const p = principalOf(req);
  if (p.kind === 'thread') {
    const c = scopeOf(req).caller(p.terminalId);
    return void res.json({
      kind: 'thread', terminalId: p.terminalId,
      sessionId: c?.sessionId ?? null, role: c?.role ?? null, depth: c?.depth ?? null,
      spawnedBy: c?.spawnedBy ?? null, roleRun: c?.roleRun ?? false, overseer: c?.overseer ?? false,
    });
  }
  if (p.kind === 'chat') return void res.json({ kind: 'chat', startedBy: p.startedBy });
  if (p.kind === 'shell') return void res.json({ kind: 'shell', terminalId: p.terminalId });
  res.json({ kind: p.kind });
};

/** GET /api/access/no-credential-stats: not for key principals. */
export function noCredentialStatsHandler(stats: NoCredentialStats): RequestHandler {
  return (req, res) => {
    const p = principalOf(req);
    if (p.kind === 'thread' || p.kind === 'chat' || p.kind === 'shell') {
      return void res.status(403).json({ error: 'owner_only', message: 'Only the owner can read these counts.' });
    }
    res.json(stats.snapshot());
  };
}
