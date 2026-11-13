import { readHostContext } from '../profile/host-context.js';
import type { RequestHandler } from 'express';

/** A Host header value that is safe to put in a CSP source list: letters, digits, dot, dash, colon, brackets. */
const SAFE_HOST = /^[A-Za-z0-9.\-:[\]]{1,255}$/;

/**
 * The Content-Security-Policy for the app.
 *
 * - Scripts only from the app itself: no inline script, no eval, no `javascript:` URL.
 * - `connect-src` is the app's own origin plus its WebSocket address, so a script cannot post data to
 *   another site. The WebSocket address is spelled out from the Host header because older Safari does not
 *   treat 'self' as covering ws:/wss:.
 * - Images may come from any http(s) address. This is open on purpose: Markdown shows a remote image
 *   only after the reader clicks "Load image" (Markdown.tsx), and that click loads it. Two other places
 *   load remote images by design: release-note avatars and chat image blocks that carry a URL.
 * - The sign-in page has an inline script, so it sends its own policy (signin-page.ts).
 * - Styles: inline style attributes are used all over the client, and the web fonts come from Google Fonts.
 * - Frames: the Browser tab shows any web page in an iframe, so `frame-src` is open; nothing may frame the app.
 */
/** The origin of OS for a hosted box (OS_PUBLIC_URL, else OS_BASE_URL), or '' (read once at start). */
export function osOriginFor(env: NodeJS.ProcessEnv): string {
  const ctx = readHostContext(env, () => {});
  if (!ctx.hosted || !ctx.osBaseUrl) return '';
  try { return new URL(ctx.osBaseUrl).origin; } catch { return ''; }
}
const OS_ORIGIN = osOriginFor(process.env);

export function contentSecurityPolicy(host?: string, osOrigin: string = OS_ORIGIN): string {
  const ws = host && SAFE_HOST.test(host) ? ` ws://${host} wss://${host}` : '';
  // A hosted box: the page asks Polywood OS for its app list (GET {OS}/api/dispatch/shell). Same origin in
  // production; the OS origin is named for a setup where it is not. Local installs: nothing added.
  const os = osOrigin ? ` ${osOrigin}` : '';
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob: http: https:",
    "media-src 'self' blob:",
    `connect-src 'self'${ws}${os}`,
    'frame-src http: https:',
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * Headers for every response (network exposure spec, 7.13).
 */
export const securityHeaders: RequestHandler = (req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', contentSecurityPolicy(req.headers.host));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
};
