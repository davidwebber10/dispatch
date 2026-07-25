import crypto from 'node:crypto';
import type { RequestHandler } from 'express';
import type { IncomingMessage } from 'node:http';

/**
 * Shared-secret gate for a hosted box.
 *
 * The daemon has no user model and no request auth of its own — locally that's fine
 * because the gate is the network (loopback / Tailscale / Cloudflare Access). In the
 * hosted deployment the box sits in a private subnet reachable only from the router,
 * and the router is what verifies the Cloudflare Access JWT and checks the caller
 * actually owns this box.
 *
 * So this layer is deliberately dumb: a constant-time comparison of one header the
 * router injects. It exists as defence in depth, so a routing or security-group
 * misconfiguration isn't a single point of failure — not as the primary control.
 * That also keeps a Cloudflare dependency out of this repo entirely.
 *
 * Unset DISPATCH_BOX_TOKEN ⇒ no-op, so a local daemon behaves exactly as before.
 */
export const BOX_TOKEN_HEADER = 'x-dispatch-box-token';

/** Timing-safe compare that tolerates length mismatch without leaking it. */
export function tokenMatches(expected: string, provided: string | undefined): boolean {
  if (!provided) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  // timingSafeEqual throws on unequal lengths, so hash both to a fixed width first.
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function headerValue(req: { headers: IncomingMessage['headers'] }): string | undefined {
  const raw = req.headers[BOX_TOKEN_HEADER];
  return Array.isArray(raw) ? raw[0] : raw;
}

/** Express middleware. Returns undefined when no token is configured. */
export function requireBoxToken(expected: string | undefined): RequestHandler | undefined {
  if (!expected) return undefined;
  return (req, res, next) => {
    if (tokenMatches(expected, headerValue(req))) return next();
    res.status(401).json({ error: 'unauthorized' });
  };
}

/**
 * WebSocket-upgrade equivalent. MUST be applied in the `server.on('upgrade')`
 * handler as well as the HTTP stack: Express middleware never runs for an upgrade,
 * so protecting only the routes leaves every terminal and structured socket — i.e.
 * full interactive access to the box — completely open.
 */
export function upgradeAllowed(expected: string | undefined, req: IncomingMessage): boolean {
  if (!expected) return true;
  return tokenMatches(expected, headerValue(req));
}
