/**
 * The app's addresses (engineering program 2026-11-09, W2-F). One `Route` names a screen; `parseRoute`
 * reads it from a path and `routeHref` writes the path. Both take the base path the client is served
 * under (lib/basePath.ts `BASE`), so nothing here reads `location`.
 *
 *   /                         the Threads view (code name `workspace`)
 *   /p/:project               a project
 *   /p/:project/t/:thread     a thread (the address a notification opens; the phone used it first)
 *   /p/:project/a/:agent      an agent (a schedule)
 *   /settings                 Settings
 *   /settings/:section        one section; /settings/:section/:subPage one item's page in it
 *   /chat   /analytics        those views
 *   /x/:pluginView            a plugin's screen: the view key without its `plugin:` prefix
 *
 * A path that is none of these parses as the workspace root, so an old or mistyped link opens the app.
 */
export type Route =
  | { view: 'workspace'; projectId?: string; threadId?: string; agentId?: string }
  | { view: 'settings'; section?: string; subPage?: string }
  | { view: 'chat' }
  | { view: 'analytics' }
  | { view: `plugin:${string}` };

const ROOT: Route = { view: 'workspace' };
const PLUGIN = 'plugin:';

/** One path segment. A colon is legal inside a segment and keeps a plugin key readable. */
const seg = (s: string): string => encodeURIComponent(s).replace(/%3A/gi, ':');
const trimBase = (basePath: string): string => basePath.replace(/\/+$/, '');

/** The path inside the app: `pathname` without the base, or null when the path is not under the base. */
function inApp(pathname: string, basePath: string): string | null {
  const base = trimBase(basePath);
  if (!base) return pathname;
  if (pathname === base) return '/';
  return pathname.startsWith(base + '/') ? pathname.slice(base.length) : null;
}

export function parseRoute(pathname: string, basePath: string): Route {
  const path = inApp(pathname, basePath);
  if (path === null) return ROOT;
  let parts: string[];
  try { parts = path.replace(/^\/+|\/+$/g, '').split('/').map(decodeURIComponent); } catch { return ROOT; }
  if (parts.some((p) => !p)) return ROOT; // the root itself, or an empty segment
  const [head, a, b, c] = parts;
  const n = parts.length;
  if (head === 'p') {
    if (n === 2) return { view: 'workspace', projectId: a };
    if (n === 4 && b === 't') return { view: 'workspace', projectId: a, threadId: c };
    if (n === 4 && b === 'a') return { view: 'workspace', projectId: a, agentId: c };
    return ROOT;
  }
  if (head === 'settings') {
    if (n === 1) return { view: 'settings' };
    if (n === 2) return { view: 'settings', section: a };
    if (n === 3) return { view: 'settings', section: a, subPage: b };
    return ROOT;
  }
  if (head === 'chat' && n === 1) return { view: 'chat' };
  if (head === 'analytics' && n === 1) return { view: 'analytics' };
  if (head === 'x' && n === 2) return { view: `${PLUGIN}${a}` };
  return ROOT;
}

/** The path inside the app for a route. Always starts with '/'. */
export function routePath(route: Route): string {
  if (route.view === 'workspace') {
    if (!route.projectId) return '/';
    const p = `/p/${seg(route.projectId)}`;
    if (route.threadId) return `${p}/t/${seg(route.threadId)}`;
    if (route.agentId) return `${p}/a/${seg(route.agentId)}`;
    return p;
  }
  if (route.view === 'settings') {
    if (!route.section) return '/settings';
    return route.subPage ? `/settings/${seg(route.section)}/${seg(route.subPage)}` : `/settings/${seg(route.section)}`;
  }
  if (route.view === 'chat') return '/chat';
  if (route.view === 'analytics') return '/analytics';
  return `/x/${seg(route.view.slice(PLUGIN.length))}`;
}

export function routeHref(route: Route, basePath: string): string {
  return trimBase(basePath) + routePath(route);
}

/** Two routes with the same address. */
export function sameRoute(a: Route, b: Route): boolean {
  return routePath(a) === routePath(b);
}
