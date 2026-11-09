import { createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto';

/**
 * Cloudflare Access assertion check (engineering program v4.5.0, W1-C).
 *
 * A request that came through a Cloudflare Tunnel behind an Access policy carries
 * `Cf-Access-Jwt-Assertion`: a JWT that Cloudflare signed for one team and one application
 * (the `aud` tag). An allow-listed host name alone proves nothing: any process on this machine,
 * and any tunnel that keeps the Host header, can send it. The signed assertion proves that the
 * request passed the owner's Access policy.
 *
 * RS256 only, verified with node:crypto. No dependency.
 */

export interface Jwk { kty: string; kid?: string; alg?: string; use?: string; n?: string; e?: string; [k: string]: unknown }
export interface Jwks { keys: Jwk[] }

export type CfAccessFailure =
  | 'malformed' | 'alg' | 'kid' | 'signature' | 'aud' | 'iss' | 'expired' | 'not-yet-valid' | 'jwks-unavailable';
export type CfAccessResult = { ok: true; email?: string } | { ok: false; reason: CfAccessFailure };

export interface CloudflareAccessConfig { teamDomain: string; aud: string }

export interface CfAccessVerifierOptions extends CloudflareAccessConfig {
  /** Reads the team's public keys. The default is an HTTPS GET with a 5 s limit. */
  fetchJwks?: (url: string) => Promise<Jwks>;
  /** Milliseconds. */
  now?: () => number;
  /** One line when the keys cannot be read; at most one per minute. */
  log?: (line: string) => void;
}

export interface CfAccessVerifier { verify(jwt: string): Promise<CfAccessResult> }

const CLOCK_TOLERANCE_S = 60;
const REFETCH_MS = 60_000;
/** A real assertion is 1 to 2 KB. A larger header value is not one. */
const MAX_JWT_LENGTH = 16_384;
const TEAM_DOMAIN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;
const AUD_TAG = /^[A-Za-z0-9_-]{16,256}$/;

/**
 * The saved `{ teamDomain, aud }`, cleaned, or null when either value is not valid.
 * The team domain is `<name>.cloudflareaccess.com` (a pasted `https://` and a last `/` are dropped).
 * The aud is the "Application Audience (AUD) Tag" of the Access application.
 */
export function parseCloudflareAccess(v: unknown): CloudflareAccessConfig | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as { teamDomain?: unknown; aud?: unknown };
  if (typeof o.teamDomain !== 'string' || typeof o.aud !== 'string') return null;
  const teamDomain = o.teamDomain.trim().toLowerCase().replace(/^https:\/\//, '').replace(/\/$/, '');
  const aud = o.aud.trim();
  return TEAM_DOMAIN.test(teamDomain) && AUD_TAG.test(aud) ? { teamDomain, aud } : null;
}

async function defaultFetchJwks(url: string): Promise<Jwks> {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'error', headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as Jwks;
}

function decodePart(part: string): Record<string, unknown> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) return null;
  try {
    const v: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch { return null; }
}

export function createCfAccessVerifier(opts: CfAccessVerifierOptions): CfAccessVerifier {
  const now = opts.now ?? Date.now;
  const fetchJwks = opts.fetchJwks ?? defaultFetchJwks;
  const log = opts.log ?? ((line: string) => console.warn(line));
  const certsUrl = `https://${opts.teamDomain}/cdn-cgi/access/certs`;
  const issuer = `https://${opts.teamDomain}`;

  let keys = new Map<string, KeyObject>();
  /** A key set was read at least once. */
  let loaded = false;
  let lastFailAt = -Infinity;
  /** The last read made for a kid that the loaded set did not hold. */
  let lastRefetchAt = -Infinity;
  let inflight: Promise<boolean> | null = null;

  /** Read the key set and replace the cache. False when the read failed (the cache is kept). */
  const load = (): Promise<boolean> => {
    inflight ??= (async () => {
      try {
        const set = await fetchJwks(certsUrl);
        if (!set || !Array.isArray(set.keys)) throw new Error('not a key set');
        const next = new Map<string, KeyObject>();
        for (const jwk of set.keys) {
          if (!jwk || jwk.kty !== 'RSA' || typeof jwk.kid !== 'string' || !jwk.kid) continue;
          try { next.set(jwk.kid, createPublicKey({ key: jwk as never, format: 'jwk' })); } catch { /* skip a key Node cannot read */ }
        }
        keys = next;
        loaded = true;
        return true;
      } catch {
        lastFailAt = now();
        // The line names the team, never the token.
        log(`Cloudflare Access: cannot read the keys of ${opts.teamDomain}. Requests through an allow-listed host get the sign-in page until the keys can be read.`);
        return false;
      } finally { inflight = null; }
    })();
    return inflight;
  };

  /** The key for a kid, or the reason there is none. */
  const keyFor = async (kid: string): Promise<KeyObject | 'kid' | 'jwks-unavailable'> => {
    const cached = keys.get(kid);
    if (cached) return cached;
    const t = now();
    const failedLately = t - lastFailAt < REFETCH_MS;
    if (inflight === null && (failedLately || (loaded && t - lastRefetchAt < REFETCH_MS))) {
      return failedLately ? 'jwks-unavailable' : 'kid';
    }
    const joining = inflight !== null;
    const wasLoaded = loaded;
    if (!joining && wasLoaded) lastRefetchAt = t;
    const ok = await load();
    if (!ok) return 'jwks-unavailable';
    const found = keys.get(kid);
    // The first read did not hold the kid either: that read was this minute's one try.
    if (!found && !wasLoaded) lastRefetchAt = t;
    return found ?? 'kid';
  };

  return {
    async verify(jwt) {
      const fail = (reason: CfAccessFailure): CfAccessResult => ({ ok: false, reason });
      if (typeof jwt !== 'string' || jwt.length === 0 || jwt.length > MAX_JWT_LENGTH) return fail('malformed');
      const parts = jwt.split('.');
      if (parts.length !== 3) return fail('malformed');
      const header = decodePart(parts[0]);
      const claims = decodePart(parts[1]);
      if (!header || !claims) return fail('malformed');
      // The algorithm is fixed here. The token's own header never picks it: `none` and HS256 are refused.
      if (header.alg !== 'RS256') return fail('alg');
      if (typeof header.kid !== 'string' || !header.kid) return fail('kid');
      if (!/^[A-Za-z0-9_-]+$/.test(parts[2])) return fail('malformed');

      const key = await keyFor(header.kid);
      if (typeof key === 'string') return fail(key);
      let good = false;
      try { good = verifySignature('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url')); } catch { good = false; }
      if (!good) return fail('signature');

      if (claims.iss !== issuer) return fail('iss');
      const aud = claims.aud;
      const audOk = typeof aud === 'string' ? aud === opts.aud : Array.isArray(aud) && aud.includes(opts.aud);
      if (!audOk) return fail('aud');
      const nowS = now() / 1000;
      if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || nowS > claims.exp + CLOCK_TOLERANCE_S) return fail('expired');
      if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || nowS + CLOCK_TOLERANCE_S < claims.nbf)) return fail('not-yet-valid');
      return typeof claims.email === 'string' && claims.email ? { ok: true, email: claims.email } : { ok: true };
    },
  };
}

let shared: { key: string; verifier: CfAccessVerifier } | null = null;

/** The process-wide verifier for a config. It is kept while the config stays the same, so the keys stay cached. */
export function cfAccessVerifierFor(config: CloudflareAccessConfig): CfAccessVerifier {
  const key = `${config.teamDomain}|${config.aud}`;
  if (shared?.key !== key) shared = { key, verifier: createCfAccessVerifier(config) };
  return shared.verifier;
}
