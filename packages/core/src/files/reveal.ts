import { execFile } from 'child_process';

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
 * The three request facts `canReveal` needs. Deliberately NOT the Express Request type: this
 * module stays framework-free and unit-testable.
 */
export interface RevealClient {
  /** req.socket.remoteAddress — kernel-supplied, unforgeable. */
  remoteAddress: string | undefined;
  /** req.headers.host — what the BROWSER thinks it connected to. */
  host: string | undefined;
  /** True if any proxy-forwarding header is present (x-forwarded-for, forwarded, cf-connecting-ip). */
  proxied: boolean;
}

/**
 * Reveal is only meaningful when Finder exists AND the browser is on THIS machine — otherwise
 * we would pop Finder on the headless mini's screen, which nobody is looking at.
 *
 * A loopback socket address is NECESSARY BUT NOT SUFFICIENT. A reverse proxy running on the same
 * host — which is exactly what this repo documents (docs/cloudflare.md points cloudflared at
 * `http://localhost:3456`, and `tailscale serve` has the same topology) — dials the daemon over
 * loopback on behalf of every remote visitor. The kernel then reports a genuine 127.0.0.1 peer
 * for a browser that may be on the other side of the planet.
 *
 * Two extra facts close that hole:
 *
 *  - **Host header.** A browser on this Mac sends `Host: localhost:3456`; one on the public tunnel
 *    URL sends `Host: dispatch.example.com` even though the socket underneath is loopback. The
 *    proxy forwards the header verbatim by default, so this is what actually distinguishes them.
 *  - **Proxy headers.** Cloudflare always sets `cf-connecting-ip` (and `x-forwarded-for`), so this
 *    still refuses even if someone configures cloudflared's `httpHostHeader` to rewrite Host to
 *    `localhost:3456`. Belt and braces.
 *
 * Any proxy in front therefore means "the browser is NOT here" — fail closed.
 */
export function canReveal(client: RevealClient, platform: string = process.platform): boolean {
  return (
    platform === 'darwin' &&
    client.proxied === false &&
    isLoopbackAddress(client.remoteAddress) &&
    isLoopbackHost(client.host)
  );
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

/**
 * Select the given absolute paths in Finder. Passing several paths at once makes Finder open
 * them ALREADY MULTI-SELECTED — which is the whole point: Finder's own Cmd-C pastes into upload
 * fields, something a web page's clipboard can never do for arbitrary files.
 *
 * Argument array, never a shell string: a file named `$(rm -rf ~).png` is just a filename.
 * Absolute binary path, never a PATH lookup: the daemon runs under launchd, whose environment
 * is minimal and need not contain /usr/bin.
 */
export function revealInFinder(absPaths: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/open', ['-R', ...absPaths], { timeout: 3000 }, (err) => (err ? reject(err) : resolve()));
  });
}
