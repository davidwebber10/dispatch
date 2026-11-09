import express from 'express';
import type { IncomingMessage } from 'node:http';
import { isLoopbackAddress } from '../files/reveal.js';
import { tokenMatches } from './box-token.js';
import { COOKIE_MAX_AGE_SECONDS, COOKIE_NAME, cookieValue, deviceCookieValue, parseCookies } from './access-token.js';
import { describePeer, legacyKey, type DeviceStore, type Peer } from './devices.js';
import { signInPage, signInPageCsp } from './signin-page.js';
import type { PairCodes } from './pair-code.js';
import {
  isLoopbackName, normalizeHostHeader, originHostPort, type AccessConfig,
} from './known-hosts.js';
import { isTailscaleAddress, type TailscaleAccess } from './tailscale-access.js';
import { cfAccessVerifierFor, type CfAccessVerifier, type CloudflareAccessConfig } from './cf-access.js';

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
  /** The single X-Forwarded-For entry (undefined for a chain or an empty header). `tailscale serve` sets it to the tailnet client. */
  forwardedFor: string | undefined;
  /** The nearest proxy's view of the client (last X-Forwarded-For entry), for the device list only. */
  nearestForwardedFor?: string;
  userAgent?: string;
  /** `Cf-Access-Jwt-Assertion`: the JWT that Cloudflare Access adds after its own sign-in. Checked only when the owner turned the check on. */
  cfAccessJwt?: string;
  isApi: boolean;
  isUpgrade: boolean;
}

export interface GateDeps {
  getToken(): string;
  isGatewayPeer(addr: string | undefined): boolean;
  config: AccessConfig;
  tailscale: TailscaleAccess;
  /** Signed-in devices. Absent on a hosted box and in tests that predate the device list: the cookie is then the old shared one. */
  devices?: DeviceStore;
  /** The Cloudflare Access verifier for a saved config. Tests pass a fake; the default keeps one per config, with its key cache. */
  cfAccess?: (config: CloudflareAccessConfig) => CfAccessVerifier;
}

/** What a request proved. A cookie names a device, or (deviceId null) is the shared cookie from before the device list. */
export type Credential = { kind: 'token' } | { kind: 'cookie'; deviceId: string | null };

export type Decision =
  | { ok: true; via: 'credential' | 'local' | 'tailscale'; credential?: Credential }
  | { ok: false; status: 401 | 403; error: 'auth_required' | 'origin_refused' };

const DENY_AUTH: Decision = { ok: false, status: 401, error: 'auth_required' };
const DENY_ORIGIN: Decision = { ok: false, status: 403, error: 'origin_refused' };

/**
 * Which owner credential a request carries. With a device store, a cookie counts when it names a
 * live device, or when it is the shared cookie from before the device list and the owner has not
 * ended those. Without one, only the shared cookie exists.
 */
export function resolveCredential(
  authorization: string | undefined, cookieHeader: string | undefined, token: string, devices?: DeviceStore,
): Credential | null {
  if (authorization && /^Bearer /i.test(authorization) && tokenMatches(token, authorization.slice(7).trim())) return { kind: 'token' };
  const cookie = parseCookies(cookieHeader)[COOKIE_NAME];
  if (!cookie) return null;
  if (devices) {
    const d = devices.verify(cookie);
    if (d) return { kind: 'cookie', deviceId: d.id };
    return tokenMatches(cookieValue(token), cookie) && devices.legacyAllowed() ? { kind: 'cookie', deviceId: null } : null;
  }
  return tokenMatches(cookieValue(token), cookie) ? { kind: 'cookie', deviceId: null } : null;
}

/** Which owner credential a request carries: the Bearer access token, the cookie, or neither. */
export function ownerCredentialKind(
  authorization: string | undefined, cookieHeader: string | undefined, token: string, devices?: DeviceStore,
): 'token' | 'cookie' | null {
  return resolveCredential(authorization, cookieHeader, token, devices)?.kind ?? null;
}

export function hasOwnerCredential(authorization: string | undefined, cookie: string | undefined, token: string): boolean {
  return ownerCredentialKind(authorization, cookie, token) !== null;
}

/** Symbol under which the gate middleware records how it admitted a request (read by the principal middleware). */
export const GATE_VIA = Symbol('dispatch.gateVia');
/** The device id the gate settled on for this request (a device cookie, or a device it just made from the old cookie). */
export const GATE_DEVICE = Symbol('dispatch.gateDevice');

async function isKnownLocalHost(req: GateRequest, host: string, deps: GateDeps): Promise<boolean> {
  // A loopback name does not prove the caller is local when a proxy relayed the request: some
  // tunnels rewrite Host to `localhost`. Such a request needs a name the owner vouched for.
  if (!req.proxied && isLoopbackName(host)) return true;
  if (deps.config.allowedHosts().includes(host)) {
    // No Cloudflare Access check saved: the name alone vouches, as before.
    const cf = deps.config.cloudflareAccess();
    if (!cf) return true;
    // Check on: the name counts only with an assertion that Cloudflare signed for the owner's team
    // and application. Without one the host is not vouched for here, and the request goes on to the
    // normal sign-in (cookie or token). This is never a hard refusal.
    if (cf.teamDomain && cf.aud && req.cfAccessJwt) {
      try {
        if ((await (deps.cfAccess ?? cfAccessVerifierFor)(cf).verify(req.cfAccessJwt)).ok) return true;
      } catch { /* not vouched */ }
    }
  }
  // A Tailscale name counts for a loopback peer only when `tailscale serve` vouched for the
  // caller. Funnel traffic (public internet) carries no identity header, so it falls through.
  // The login must be the owner's: a coworker on a shared tailnet reaches `tailscale serve` too (NE-3).
  if (req.tailscaleUserLogin && req.tailscaleFunnel === undefined) { // Funnel: any value, even empty, means public
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
  const credential = resolveCredential(req.authorization, req.cookie, deps.getToken(), deps.devices);
  if (credential) {
    via = 'credential';
  } else if (host && (isLoopbackAddress(peer) || deps.isGatewayPeer(peer)) && (await isKnownLocalHost(req, host, deps))) {
    via = 'local';
  } else if (host && isTailscaleAddress(peer) && (await deps.tailscale.isOwnerPeer(peer))) {
    const me = await deps.tailscale.self();
    if (me && (me.names.includes(host) || me.ips.includes(host))) via = 'tailscale';
  }
  if (!via) return DENY_AUTH;
  return originAllowed(req, deps.config) ? { ok: true, via, ...(via === 'credential' ? { credential: credential! } : {}) } : DENY_ORIGIN;
}

type Headers = IncomingMessage['headers'];
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Last X-Forwarded-For entry. Earlier entries are whatever the client sent; the last is the nearest proxy's view. */
function lastForwarded(h: Headers): string | undefined {
  return one(h['x-forwarded-for'])?.split(',').pop()?.trim() || undefined;
}

/** The single X-Forwarded-For entry, or undefined when the header is absent, empty or a chain. */
function soleForwarded(h: Headers): string | undefined {
  const raw = one(h['x-forwarded-for']);
  if (raw === undefined) return undefined;
  // `tailscale serve` sets exactly one entry. A chain means a client-supplied entry went through a
  // proxy that appended or kept it, so no entry can be trusted to name the real caller.
  const parts = raw.split(',').map((x) => x.trim());
  return parts.length === 1 && parts[0] ? parts[0] : undefined;
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
    // Presence, not truthiness: an empty relay header still says a proxy relayed the request.
    proxied: ['x-forwarded-for', 'forwarded', 'cf-connecting-ip', 'x-real-ip'].some((n) => h[n] !== undefined),
    forwardedFor: soleForwarded(h),
    nearestForwardedFor: lastForwarded(h),
    userAgent: one(h['user-agent']),
    cfAccessJwt: one(h['cf-access-jwt-assertion']),
    isApi,
    isUpgrade,
  };
}

const LOGIN_PATH = '/api/access/login';
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_FAILURES = 10;

/** Upper bound on the sign-in failure map: a flood of callers cannot grow it without limit. */
const LOGIN_MAX_BUCKETS = 1000;

/** The sign-in failure count for each caller (a bucket: the peer, or the peer and the proxy's view of the client). */
export interface LoginLimiter {
  /** True while the caller has `LOGIN_MAX_FAILURES` failures in the current window. An ended window is forgotten. */
  blocked(bucket: string): boolean;
  /** Count one failed try. */
  fail(bucket: string): void;
  /** A good sign-in: forget the caller. */
  clear(bucket: string): void;
  has(bucket: string): boolean;
  size(): number;
}

/**
 * The map never holds more than `cap` entries. When it is full and a NEW caller fails, room is made in this order:
 * entries whose window ended, then the oldest entries that are not blocked, then the oldest blocked entries.
 * It is never cleared as a whole: that let anyone free every blocked caller by failing from 1,000 other addresses.
 * A blocked caller is evicted only when every entry in the map is blocked.
 */
export function createLoginLimiter(now: () => number = Date.now, cap: number = LOGIN_MAX_BUCKETS): LoginLimiter {
  // Insertion order is age order: `start` is set when the entry is made and kept on every later failure.
  const failures = new Map<string, { n: number; start: number }>();
  const live = (bucket: string) => {
    const rec = failures.get(bucket);
    if (rec && now() - rec.start >= LOGIN_WINDOW_MS) { failures.delete(bucket); return undefined; }
    return rec;
  };
  const makeRoom = () => {
    for (const [k, v] of failures) if (now() - v.start >= LOGIN_WINDOW_MS) failures.delete(k);
    for (const [k, v] of failures) {
      if (failures.size < cap) return;
      if (v.n < LOGIN_MAX_FAILURES) failures.delete(k);
    }
    for (const k of failures.keys()) {
      if (failures.size < cap) return;
      failures.delete(k);
    }
  };
  return {
    blocked: (bucket) => (live(bucket)?.n ?? 0) >= LOGIN_MAX_FAILURES,
    fail(bucket) {
      const rec = live(bucket);
      if (!rec && failures.size >= cap) makeRoom();
      failures.set(bucket, { n: (rec?.n ?? 0) + 1, start: rec?.start ?? now() });
    },
    clear: (bucket) => { failures.delete(bucket); },
    has: (bucket) => failures.has(bucket),
    size: () => failures.size,
  };
}

export interface AccessGateOptions extends GateDeps {
  /** Mount prefix (already stripped from req.url upstream). Used for the cookie Path and the sign-in page. */
  basePath: string;
  /** One-time pairing codes from Settings → Devices & access; the login route takes `{ code }` as well as `{ token }`. */
  pairCodes?: PairCodes;
  now?: () => number;
}

export interface AccessGate {
  /** Mount after the box-token gate and the base-path strip, before body parsing. */
  middleware: express.RequestHandler;
  /** Mount as `app.post('/api/access/login', ...gate.loginRoute)` before the middleware. */
  loginRoute: (express.RequestHandler | express.ErrorRequestHandler)[];
  /** Decision for a WebSocket upgrade. */
  upgradeDecision(req: IncomingMessage, strippedUrl: string): Promise<Decision>;
  /** Key that ties an upgrade made with the shared cookie to the device later made from that cookie. */
  legacyKey(req: IncomingMessage): string;
}

export function createAccessGate(opts: AccessGateOptions): AccessGate {
  const now = opts.now ?? Date.now;
  const cookiePath = opts.basePath || '/';
  const failures = createLoginLimiter(now);

  const peerOf = (f: GateRequest): Peer => describePeer(f.remoteAddress, f.nearestForwardedFor, opts.isGatewayPeer);

  /** The Set-Cookie line for a device cookie: same attributes the old cookie had. */
  const deviceCookieHeader = (req: { socket: unknown; headers: Headers }, id: string): string => {
    const peer = (req.socket as { remoteAddress?: string }).remoteAddress;
    const viaProxy = isLoopbackAddress(peer) || opts.isGatewayPeer(peer);
    const https = (req.socket as { encrypted?: boolean }).encrypted === true ||
      (viaProxy && one(req.headers['x-forwarded-proto']) === 'https');
    return `${COOKIE_NAME}=${deviceCookieValue(opts.getToken(), id)}; Path=${cookiePath}; Max-Age=${COOKIE_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax${https ? '; Secure' : ''}`;
  };

  /**
   * After a request passed with a cookie: record the device as seen, or, for the shared cookie
   * from before the device list, make a device for this browser and hand it its own cookie
   * (HTTP only; a WebSocket upgrade cannot set one). Returns the device id, or null.
   */
  const noteDevice = (f: GateRequest, d: Extract<Decision, { ok: true }>, setCookie: ((id: string) => void) | null): string | null => {
    const devices = opts.devices;
    const c = d.credential;
    if (!devices || !c || c.kind !== 'cookie') return null;
    if (c.deviceId) { devices.touch(c.deviceId, peerOf(f), f.userAgent); return c.deviceId; }
    if (!setCookie) return null;
    const adopted = devices.adoptLegacy(f.userAgent, peerOf(f));
    setCookie(adopted.id);
    return adopted.id;
  };

  const middleware: express.RequestHandler = (req, res, next) => {
    // Express routes case-insensitively, so /API/x reaches the same handlers as /api/x.
    const lower = req.path.toLowerCase();
    const isApi = lower === '/api' || lower.startsWith('/api/');
    const facts = factsFrom(req, isApi, false);
    decide(facts, opts).then((d) => {
      if (d.ok) {
        const tagged = req as unknown as Record<symbol, unknown>;
        tagged[GATE_VIA] = d.via;
        const deviceId = noteDevice(facts, d, (id) => res.append('Set-Cookie', deviceCookieHeader(req, id)));
        if (deviceId) tagged[GATE_DEVICE] = deviceId;
        return next();
      }
      res.setHeader('Cache-Control', 'no-store');
      if (d.status === 401 && !isApi && (req.method === 'GET' || req.method === 'HEAD')) {
        res.setHeader('Content-Security-Policy', signInPageCsp(opts.basePath));
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
    if (failures.blocked(bucket)) return void res.status(429).json({ error: 'too_many_tries' });

    const given = (req.body as { token?: unknown; code?: unknown } | undefined) ?? {};
    const token = opts.getToken();
    // `{ code }` is a one-time pairing code (pair-code.ts); `{ token }` the long-lived token. A
    // failed code counts against the same per-caller budget as a failed token.
    const codeOk = typeof given.code === 'string' && !!opts.pairCodes && opts.pairCodes.redeem(given.code);
    const tokenOk = typeof given.token === 'string' && tokenMatches(token, given.token);
    if (!codeOk && !tokenOk) {
      failures.fail(bucket);
      return void res.status(401).json({ error: typeof given.code === 'string' ? 'bad_code' : 'bad_token' });
    }
    failures.clear(bucket);
    if (opts.devices) {
      // Each sign-in is a device. A browser that signs in again keeps the device it has.
      const facts = factsFrom(req, true, false);
      const held = opts.devices.verify(parseCookies(facts.cookie)[COOKIE_NAME]);
      const id = held?.id ?? opts.devices.create({ userAgent: facts.userAgent, via: codeOk ? 'code' : 'token', peer: peerOf(facts) }).id;
      res.setHeader('Set-Cookie', deviceCookieHeader(req, id));
    } else {
      const viaProxy = isLoopbackAddress(peer) || opts.isGatewayPeer(peer);
      const https = (req.socket as { encrypted?: boolean }).encrypted === true ||
        (viaProxy && one(req.headers['x-forwarded-proto']) === 'https');
      res.setHeader('Set-Cookie',
        `${COOKIE_NAME}=${cookieValue(token)}; Path=${cookiePath}; Max-Age=${COOKIE_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax${https ? '; Secure' : ''}`);
    }
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
    legacyKey: (req) => { const f = factsFrom(req, true, true); return legacyKey(f.userAgent, peerOf(f)); },
    upgradeDecision: async (req, strippedUrl) => {
      const facts = factsFrom(req, strippedUrl.toLowerCase().startsWith('/api/'), true);
      const d = await decide(facts, opts);
      if (d.ok) noteDevice(facts, d, null);
      return d;
    },
  };
}
