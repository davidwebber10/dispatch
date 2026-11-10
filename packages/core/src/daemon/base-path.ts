import type express from 'express';

/**
 * Mount prefix for the whole app (API + WebSockets + web bundle). '' for a local
 * daemon at the origin root; '/u/<slug>/dispatch' for a hosted box, so the whole
 * fleet lives behind ONE origin and one Cloudflare Access application.
 * Normalized to a leading slash and no trailing slash, or '' when unset.
 */
export function normalizeBasePath(raw: string | undefined): string {
  const v = (raw ?? '').trim();
  if (!v || v === '/') return '';
  return ('/' + v.replace(/^\/+/, '').replace(/\/+$/, ''));
}

/**
 * Remove the mount prefix from a URL path, or null when it doesn't carry the prefix.
 * Exact prefix (`/u/x/dispatch`) maps to '/'. A path that merely *starts with* the
 * same characters (`/u/x/dispatchfoo`) is NOT a match — it must be followed by '/'
 * or end there.
 */
export function stripPrefix(url: string, basePath: string): string | null {
  if (!basePath) return url;
  if (url === basePath) return '/';
  if (url.startsWith(basePath + '/') || url.startsWith(basePath + '?')) {
    const rest = url.slice(basePath.length);
    return rest.startsWith('/') ? rest : '/' + rest;
  }
  return null;
}

/** Express middleware form of stripPrefix; 404s anything outside the mount point. */
export function stripBasePath(basePath: string): express.RequestHandler {
  return (req, res, next) => {
    const stripped = stripPrefix(req.url, basePath);
    if (stripped === null) {
      res.status(404).end();
      return;
    }
    req.url = stripped;
    next();
  };
}
