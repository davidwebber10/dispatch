import { isLoopbackAddress } from '../files/reveal.js';
import { tokenMatches } from './box-token.js';
import { COOKIE_NAME, cookieValue, parseCookies } from './access-token.js';
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
  if (isLoopbackName(host)) return true;
  if (deps.config.allowedHosts().includes(host)) return true;
  // A Tailscale name counts for a loopback peer only when `tailscale serve` vouched for the
  // caller. Funnel traffic (public internet) carries no identity header, so it falls through.
  if (req.tailscaleUserLogin && !req.tailscaleFunnel) {
    const me = await deps.tailscale.self();
    if (me && (me.names.includes(host) || me.ips.includes(host))) return true;
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
  if (config.allowedOrigins().includes(req.origin.trim())) return true;
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
