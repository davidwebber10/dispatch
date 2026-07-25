/**
 * Base path the client is served under.
 *
 * A local daemon serves Dispatch at the origin root (`/`). A hosted box is served
 * under a per-user prefix (e.g. `/u/dwebber/dispatch`) so the whole fleet can sit
 * behind ONE origin — which is what keeps Cloudflare Access, cookies and CORS
 * simple (see the OS design doc §3.2; an iframe on a second subdomain is the
 * alternative, and CF Access cookies are documented to break there).
 *
 * The value comes from `<base href>`, which index.html ships as `/` and the daemon
 * rewrites at serve time from DISPATCH_BASE_PATH. Reading it from `document.baseURI`
 * rather than an injected global means the SAME mechanism drives relative asset
 * URLs (Vite builds with `base: './'`) and these API/WebSocket URLs — they cannot
 * drift apart.
 *
 * Deliberately NOT derived from `location.pathname`: that is the current SPA route,
 * not the mount point, so it would produce a different prefix on every navigation.
 */
export const BASE: string = (() => {
  try {
    // document.baseURI is absolute and already resolved against <base href>.
    return new URL(document.baseURI).pathname.replace(/\/+$/, '');
  } catch {
    return '';
  }
})();

/** Absolute path for an app-root-relative path, e.g. apiPath('/api/sessions'). */
export function apiPath(path: string): string {
  return BASE + path;
}

/** ws:// or wss:// URL for an app-root-relative path, matching the page's scheme. */
export function wsUrl(path: string): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}${BASE}${path}`;
}

/**
 * The current route as the APP sees it — `location.pathname` with the mount prefix
 * removed. Routing logic (deep links, the mobile nav stack) must read this rather
 * than `location.pathname`, or every path test silently fails once the app is served
 * under a prefix. Always starts with '/'.
 */
export function appPath(pathname: string = location.pathname): string {
  if (BASE && pathname.startsWith(BASE)) {
    const rest = pathname.slice(BASE.length);
    return rest.startsWith('/') ? rest : '/' + rest;
  }
  return pathname;
}

/** Inverse of appPath(): an app-relative route → the real URL to push/replace. */
export function href(path: string): string {
  return BASE + path;
}
