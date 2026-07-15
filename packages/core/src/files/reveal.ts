/** Anchored dotted quad in 127.0.0.0/8 — the whole IPv4 loopback range. */
const IPV4_LOOPBACK = /^127(\.\d{1,3}){3}$/;

/**
 * True when the peer socket address is loopback.
 *
 * Callers MUST pass `req.socket.remoteAddress`, never `req.ip`: Express derives `req.ip` from
 * `X-Forwarded-For` when `trust proxy` is enabled, so a remote client could simply claim to be
 * 127.0.0.1. The socket peer address is set by the kernel and cannot be forged.
 *
 * The IPv4 check is anchored to match only well-formed dotted quads in 127.0.0.0/8, rejecting
 * invalid addresses like "127.0.0.1.evil.com" or "127.1" (incomplete octet list).
 */
export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  // Node reports IPv4 peers on a dual-stack socket as "::ffff:127.0.0.1".
  const a = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
  return a === '::1' || IPV4_LOOPBACK.test(a);
}

/** Strip the port off a Host header value, unwrapping the bracketed IPv6 form. */
function hostnameOf(host: string): string | null {
  const h = host.trim().toLowerCase();
  if (!h) return null;
  if (h.startsWith('[')) {                        // "[::1]:3456" — bracketed IPv6 literal
    const end = h.indexOf(']');
    return end > 1 ? h.slice(1, end) : null;
  }
  const first = h.indexOf(':');
  if (first < 0) return h;                        // "localhost"
  // More than one colon and no brackets: a bare IPv6 literal, which carries no port.
  if (h.indexOf(':', first + 1) >= 0) return h;
  return h.slice(0, first);                       // "localhost:3456" -> "localhost"
}

/**
 * True when the Host header names a loopback hostname — i.e. the browser dialed THIS machine
 * directly rather than a public name that some proxy resolved to us.
 */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const name = hostnameOf(host);
  if (!name) return false;
  return name === 'localhost' || name === '::1' || IPV4_LOOPBACK.test(name);
}

/**
 * The three request facts a platform's `isLocalClient` predicate needs. Deliberately NOT the
 * Express Request type: this module stays framework-free and unit-testable.
 */
export interface RevealClient {
  /** req.socket.remoteAddress — kernel-supplied, unforgeable. */
  remoteAddress: string | undefined;
  /** req.headers.host — what the BROWSER thinks it connected to. */
  host: string | undefined;
  /** True if any proxy-forwarding header is present (x-forwarded-for, forwarded, cf-connecting-ip). */
  proxied: boolean;
}

/** Only the parts of an http request `revealClientFrom` reads — keeps Express out of this module. */
interface RevealRequestParts {
  socket: { remoteAddress?: string | undefined };
  headers: Record<string, string | string[] | undefined>;
}

/** Build a {@link RevealClient} from a request. Shared by GET /host and POST /files/reveal. */
export function revealClientFrom(req: RevealRequestParts): RevealClient {
  const host = req.headers['host'];
  return {
    remoteAddress: req.socket.remoteAddress,
    host: Array.isArray(host) ? host[0] : host,
    proxied: !!(
      req.headers['x-forwarded-for'] ||
      req.headers['forwarded'] ||
      req.headers['cf-connecting-ip']
    ),
  };
}
