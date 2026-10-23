import express from 'express';
import type { IncomingMessage } from 'node:http';
import { isLoopbackAddress } from '../files/reveal.js';
import { tokenMatches } from './box-token.js';
import { COOKIE_MAX_AGE_SECONDS, COOKIE_NAME, cookieValue, parseCookies } from './access-token.js';
import { signInPage } from './signin-page.js';
import {
  isLoopbackName, normalizeHostHeader, originHostPort, type AccessConfig,
} from './known-hosts.js';
import { isTailscaleAddress, type TailscaleAccess } from './tailscale-access.js';

/**
 * The Phase 1 request gate (network exposure spec, section 7). `decide` is a pure function of
 * the facts of one request; the Express middleware and the WebSocket upgrade handler only
 * collect those facts and act on the answer.
 */

export interface GateRequest {
  /** req.socket.remoteAddress. Never req.ip: that can come from X-Forwarded-For. */
  remoteAddress: string | undefined;
  host: string | undefined;
  origin: string | undefined;
  secFetchSite: string | undefined;
  authorization: string | undefined;
  cookie: string | undefined;
  tailscaleUserLogin: string | undefined;
  tailscaleFunnel: string | undefined;
  /** Path starts with /api (after the base-path strip). */
  /** x-forwarded-for, forwarded, cf-connecting-ip or x-real-ip present: a proxy on this machine relayed the request. */
  proxied: boolean;
  /** Last X-Forwarded-For entry: the address the nearest proxy saw. `tailscale serve` sets it to the tailnet client. */
  forwardedFor: string | undefined;
  isApi: boolean;
  isUpgrade: boolean;
}

export interface GateDeps {
  getToken(): string;
  isGatewayPeer(addr: string | undefined): boolean;
  config: AccessConfig;
  tailscale: TailscaleAccess;
}

export type Decision =
  | { ok: true; via: 'credential' | 'local' | 'tailscale' }
  | { ok: false; status: 401 | 403; error: 'auth_required' | 'origin_refused' };

const DENY_AUTH: Decision = { ok: false, status: 401, error: 'auth_required' };
const DENY_ORIGIN: Decision = { ok: false, status: 403, error: 'origin_refused' };

function hasCredential(req: GateRequest, token: string): boolean {
  const auth = req.authorization;
  if (auth && /^Bearer /i.test(auth) && tokenMatches(token, auth.slice(7).trim())) return true;
  const cookie = parseCookies(req.cookie)[COOKIE_NAME];
  return !!cookie && tokenMatches(cookieValue(token), cookie);
}

async function isKnownLocalHost(req: GateRequest, host: string, deps: GateDeps): Promise<boolean> {
  // A loopback name does not prove the caller is local when a proxy relayed the request: some
  // tunnels rewrite Host to `localhost`. Such a request needs a name the owner vouched for.
  if (!req.proxied && isLoopbackName(host)) return true;
  if (deps.config.allowedHosts().includes(host)) return true;
  // A Tailscale name counts for a loopback peer only when `tailscale serve` vouched for the
  // caller. Funnel traffic (public internet) carries no identity header, so it falls through.
  // The login must be the owner's: a coworker on a shared tailnet reaches `tailscale serve` too (NE-3).
  if (req.tailscaleUserLogin && !req.tailscaleFunnel) {
    const me = await deps.tailscale.self();
    if (me && me.login && req.tailscaleUserLogin.trim().toLowerCase() === me.login && (me.names.includes(host) || me.ips.includes(host))) {
      // `tailscale serve` sets X-Forwarded-For to the tailnet client. Another local proxy that keeps
      // the client's Host and merely forwards the identity header would carry a different address,
      // so when the header is there it must name one of the owner's own devices.
      // Any relay header without a verified X-Forwarded-For (Forwarded, X-Real-IP, CF-Connecting-IP) is refused.
      if (!req.proxied) return true;
      if (!req.forwardedFor) return false;
      return isTailscaleAddress(req.forwardedFor) && (await deps.tailscale.isOwnerPeer(req.forwardedFor));
    }
  }
  return false;
}

/** Port of a Host header, or null when it has none. */
function hostPort(host: string): string | null {
  const m = /:(\d+)$/.exec(host.trim());
  return m ? m[1] : null;
}

export function originAllowed(req: GateRequest, config: AccessConfig): boolean {
  const site = req.secFetchSite;
  if (!req.origin) {
    // No Origin: scripts, hooks and plain navigations. A browser still labels cross-site and
    // same-site subresource loads (img, no-cors GET) of the API, and those are refused.
    const crossish = site === 'cross-site' || site === 'same-site';
    return !(crossish && (req.isApi || req.isUpgrade));
  }
  if (config.allowedOrigins().includes(req.origin.trim().toLowerCase())) return true;
  const o = originHostPort(req.origin);
  if (!o) return false; // `null` and junk
  const host = normalizeHostHeader(req.host);
  if (!host) return false;
  const port = hostPort(req.host ?? '');
  if (o.host === host && (port ? port === o.port : o.port === '80' || o.port === '443')) return true;
  // Vite dev server: page on localhost:5173, daemon on localhost:3456. Allowed only when the
  // browser says the page is the same origin as whatever it talked to (the dev proxy forwards
  // that label), so a page on another local port (same-site) is still refused.
  if (isLoopbackName(o.host) && isLoopbackName(host) && (!site || site === 'same-origin')) return true;
  return false;
}

export async function decide(req: GateRequest, deps: GateDeps): Promise<Decision> {
  const host = normalizeHostHeader(req.host);
  const peer = req.remoteAddress;

  let via: 'credential' | 'local' | 'tailscale' | null = null;
  if (hasCredential(req, deps.getToken())) {
    via = 'credential';
  } else if (host && (isLoopbackAddress(peer) || deps.isGatewayPeer(peer)) && (await isKnownLocalHost(req, host, deps))) {
    via = 'local';
  } else if (host && isTailscaleAddress(peer) && (await deps.tailscale.isOwnerPeer(peer))) {
    const me = await deps.tailscale.self();
    if (me && (me.names.includes(host) || me.ips.includes(host))) via = 'tailscale';
  }
  if (!via) return DENY_AUTH;
  return originAllowed(req, deps.config) ? { ok: true, via } : DENY_ORIGIN;
}

type Headers = IncomingMessage['headers'];
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Last X-Forwarded-For entry. Earlier entries are whatever the client sent; the last is the nearest proxy's view. */
function lastForwarded(h: Headers): string | undefined {
  const raw = one(h['x-forwarded-for']);
  const last = raw?.split(',').pop()?.trim();
  return last || undefined;
}

function factsFrom(
  req: { socket: { remoteAddress?: string }; headers: Headers },
  isApi: boolean,
  isUpgrade: boolean,
): GateRequest {
  const h = req.headers;
  return {
    remoteAddress: req.socket.remoteAddress,
    host: one(h.host),
    origin: one(h.origin),
    secFetchSite: one(h['sec-fetch-site']),
    authorization: one(h.authorization),
    cookie: one(h.cookie),
    tailscaleUserLogin: one(h['tailscale-user-login']),
    tailscaleFunnel: one(h['tailscale-funnel-request']),
    proxied: !!(h['x-forwarded-for'] || h['forwarded'] || h['cf-connecting-ip'] || h['x-real-ip']),
    forwardedFor: lastForwarded(h),
    isApi,
    isUpgrade,
  };
}

const LOGIN_PATH = '/api/access/login';
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_FAILURES = 10;

export interface AccessGateOptions extends GateDeps {
  /** Mount prefix (already stripped from req.url upstream). Used for the cookie Path and the sign-in page. */
  basePath: string;
  now?: () => number;
}

export interface AccessGate {
  /** Mount after the box-token gate and the base-path strip, before body parsing. */
  middleware: express.RequestHandler;
  /** Mount as `app.post('/api/access/login', ...gate.loginRoute)` before the middleware. */
  loginRoute: (express.RequestHandler | express.ErrorRequestHandler)[];
  /** Decision for a WebSocket upgrade. */
  upgradeDecision(req: IncomingMessage, strippedUrl: string): Promise<Decision>;
}

export function createAccessGate(opts: AccessGateOptions): AccessGate {
  const now = opts.now ?? Date.now;
  const cookiePath = opts.basePath || '/';
  const failures = new Map<string, { n: number; start: number }>();

  const middleware: express.RequestHandler = (req, res, next) => {
    // Express routes case-insensitively, so /API/x reaches the same handlers as /api/x.
    const lower = req.path.toLowerCase();
    const isApi = lower === '/api' || lower.startsWith('/api/');
    decide(factsFrom(req, isApi, false), opts).then((d) => {
      if (d.ok) return next();
      res.setHeader('Cache-Control', 'no-store');
      if (d.status === 401 && !isApi && (req.method === 'GET' || req.method === 'HEAD')) {
        return void res.status(401).type('html').send(signInPage(opts.basePath));
      }
      res.status(d.status).json({ error: d.error });
    }).catch(next);
  };

  const login: express.RequestHandler = (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const peer = req.socket.remoteAddress ?? '?';
    // Behind a same-machine proxy every client has the same peer address, so a visitor's failed
    // tries must not lock the owner out: also key on the proxy's view of the client.
    const proxied = isLoopbackAddress(peer) || opts.isGatewayPeer(peer);
    const bucket = proxied ? `${peer}|${lastForwarded(req.headers)}` : peer;
    // Login needs no credential, but the Origin rule still applies: a web page cannot post to it.
    if (!originAllowed(factsFrom(req, true, false), opts.config)) {
      return void res.status(403).json({ error: 'origin_refused' });
    }
    let rec = failures.get(bucket);
    if (rec && now() - rec.start >= LOGIN_WINDOW_MS) { failures.delete(bucket); rec = undefined; }
    if (rec && rec.n >= LOGIN_MAX_FAILURES) return void res.status(429).json({ error: 'too_many_tries' });

    const given = (req.body as { token?: unknown } | undefined)?.token;
    const token = opts.getToken();
    if (typeof given !== 'string' || !tokenMatches(token, given)) {
      if (failures.size > 1000) {
        for (const [k, v] of failures) if (now() - v.start >= LOGIN_WINDOW_MS) failures.delete(k);
        if (failures.size > 1000) failures.clear();
      }
      failures.set(bucket, { n: (rec?.n ?? 0) + 1, start: rec?.start ?? now() });
      return void res.status(401).json({ error: 'bad_token' });
    }
    failures.delete(bucket);
    const viaProxy = isLoopbackAddress(peer) || opts.isGatewayPeer(peer);
    const https = (req.socket as { encrypted?: boolean }).encrypted === true ||
      (viaProxy && one(req.headers['x-forwarded-proto']) === 'https');
    res.setHeader('Set-Cookie',
      `${COOKIE_NAME}=${cookieValue(token)}; Path=${cookiePath}; Max-Age=${COOKIE_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax${https ? '; Secure' : ''}`);
    res.json({ ok: true });
  };

  return {
    middleware,
    loginRoute: [
      express.json({ limit: '4kb' }),
      // A malformed or oversized body must not reach the default handler: it prints a stack trace.
      ((err, _req, res, _next) => {
        void err;
        res.status(typeof err?.status === 'number' && err.status >= 400 && err.status < 500 ? err.status : 400).json({ error: 'bad_request' });
      }) as express.ErrorRequestHandler,
      login,
    ],
    upgradeDecision: (req, strippedUrl) =>
      decide(factsFrom(req, strippedUrl.toLowerCase().startsWith('/api/'), true), opts),
  };
}
