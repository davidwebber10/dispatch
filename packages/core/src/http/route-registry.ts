// packages/core/src/http/route-registry.ts
// The list of every route the app holds, read from the live app, and the seal that makes the list
// trustworthy: after `sealRoutes(app)` every route is known by its pattern, starts with the profile
// guard, and lives in a router that matches case-sensitively and strictly.
//
// Used by the daemon at build (daemon/build.ts) and by the tests that enumerate the routes.
import type { Express, Router } from 'express';
import { isBusinessGuard } from '../profile/business-gate.js';

const PREFIX = new WeakMap<object, string>();

/** Mount a router and remember where: the seal needs the pattern of the mount path, not its regexp. */
export function mountRouter(app: Pick<Express, 'use'>, prefix: string, router: Router): void {
  PREFIX.set(router, prefix);
  if (prefix) app.use(prefix, router); else app.use(router);
}

export interface RegisteredRoute {
  /** `/api/sessions/:id/terminals`: the mount path plus the route path, no trailing slash. */
  pattern: string;
  /** Upper case; `ALL` for `router.all`. */
  methods: string[];
  /** The Express Route object. */
  route: { path: unknown; stack: Array<{ handle: unknown; method?: string }>; methods: Record<string, boolean> };
}

/** The id of a route in the profile table: `GET /api/x/:id`. */
export const routeId = (method: string, pattern: string): string => `${method} ${pattern}`;

function patternOf(prefix: string, routePath: unknown): string {
  const one = (p: unknown): string => {
    // A route matched by a regular expression has no pattern; the web page's catch-all is the only one.
    if (p instanceof RegExp) return '(page)';
    const full = `${prefix}${String(p)}`;
    return full.length > 1 ? full.replace(/\/$/, '') : full;
  };
  return Array.isArray(routePath) ? routePath.map(one).join(' | ') : one(routePath);
}

interface Layer { route?: RegisteredRoute['route']; handle?: { stack?: Layer[]; caseSensitive?: boolean; strict?: boolean }; name?: string }

function walk(stack: Layer[], prefix: string, out: RegisteredRoute[], problems: string[]): void {
  for (const layer of stack) {
    if (layer.route) {
      const pattern = patternOf(prefix, layer.route.path);
      const methods = Object.keys(layer.route.methods).map((m) => (m === '_all' ? 'ALL' : m.toUpperCase()));
      if (!isBusinessGuard(layer.route.stack[0]?.handle)) problems.push(`${methods.join(',')} ${pattern}: not registered through policyRouter (no profile guard)`);
      out.push({ pattern, methods, route: layer.route });
    } else if (layer.handle && Array.isArray(layer.handle.stack)) {
      const at = PREFIX.get(layer.handle);
      if (at === undefined) { problems.push(`a router under "${prefix || '/'}" was mounted without mountRouter`); continue; }
      if (layer.handle.caseSensitive !== true || layer.handle.strict !== true) problems.push(`the router at "${prefix}${at}" does not match case-sensitively and strictly`);
      walk(layer.handle.stack, prefix + at, out, problems);
    }
  }
}

/** Every route of the app, and what is wrong with the registration of any of them. */
export function inspectRoutes(app: Express): { routes: RegisteredRoute[]; problems: string[] } {
  const routes: RegisteredRoute[] = [];
  const problems: string[] = [];
  if (!app.enabled('case sensitive routing') || !app.enabled('strict routing')) problems.push('the app does not match case-sensitively and strictly');
  const stack = (app as unknown as { _router?: { stack: Layer[] } })._router?.stack ?? [];
  walk(stack, '', routes, problems);
  return { routes, problems };
}

/**
 * Check the registration of every route and give each its pattern (`ids`, read by the profile guard).
 * Throws when a route was registered around `policyRouter` or `mountRouter`: the daemon then does not
 * start, which is the point (a route outside the table must never serve).
 */
export function sealRoutes(app: Express, ids: WeakMap<object, string>): RegisteredRoute[] {
  const { routes, problems } = inspectRoutes(app);
  if (problems.length) throw new Error(`route registration: ${problems.join('; ')}`);
  for (const r of routes) ids.set(r.route, r.pattern);
  return routes;
}
