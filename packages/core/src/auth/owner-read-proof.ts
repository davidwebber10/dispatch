import type { Request, RequestHandler } from 'express';
import { ownerOnly, ownerOnlyStrict, POLICY_TAG, type PolicyKind } from './route-policy.js';

/**
 * `ownerOnlyStrict` for a GET route (engineering program W1-B).
 *
 * `ownerOnlyStrict` knows the web page by an Origin header or by `Sec-Fetch-Site: same-origin`. A browser
 * sends Origin on a POST, PATCH, PUT and DELETE, so that is enough for those. On a GET it sends no Origin
 * to its own site, and it sends `Sec-Fetch-Site` only from a secure page (https, or localhost). A page that
 * the owner opened on plain http by a tailnet name (`http://mac.tailnet.ts.net:3456`) sends neither, and its
 * owner is a caller with no credential (the access gate lets an owner tailnet device in). Without this
 * file, "show a secret value" and "export integrations" would stop for that owner.
 *
 * The daemon sends `Referrer-Policy: same-origin` (auth/security-headers.ts), so the page's own requests
 * carry a Referer that names the page. A Referer with the same host and port as the Host header counts as
 * the web page here. Like the other two headers this is a drift check, not a lock: a program that sets
 * the header by hand passes, and a program that can read the access token can sign in as the owner anyway.
 */
export function sameOriginReferer(headers: Request['headers']): boolean {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const referer = one(headers.referer);
  const host = one(headers.host);
  if (!referer || !host) return false;
  try {
    const u = new URL(referer);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return u.host.toLowerCase() === host.trim().toLowerCase();
  } catch { return false; }
}

/**
 * Owner only, and a caller with no credential must look like the web page: Origin, `Sec-Fetch-Site: same-origin`
 * or a same-origin Referer. A key gets 403 owner_only. Any other caller with no credential gets 401 auth_required.
 */
export const ownerOnlyStrictRead: RequestHandler = (req, res, next) => {
  // A same-origin Referer is the proof: what is left is the plain owner rule (a key is still refused).
  if (sameOriginReferer(req.headers)) return ownerOnly(req, res, next);
  ownerOnlyStrict(req, res, next);
};
(ownerOnlyStrictRead as unknown as Record<symbol, PolicyKind>)[POLICY_TAG] = 'owner';
