import { Router, type Request, type RequestHandler, type Response, type RouterOptions } from 'express';
import { principalOf, scopeOf, type Principal } from './request-principal.js';
import type { KeyPrincipal } from './principals.js';
import type { CallerFacts, KeyScope } from './key-scope.js';
import { redactKeys } from './redact-keys.js';
import { pluginFactsOf, type PluginFacts } from './plugin-facts.js';
import { businessGuard, isBusinessGuard } from '../profile/business-gate.js';
export { configurePluginFacts, type PluginFacts } from './plugin-facts.js';

/**
 * Route policy (spec 6.4). Default deny: a route with no key policy is owner only.
 * Every route handler chain starts with a tagged handler (`ownerOnly`, `keyRoute(...)`
 * or `publicRoute`); `policyRouter()` adds `ownerOnly` for a route that has none.
 */
export type KeyErrorCode = 'owner_only' | 'auth_required' | 'field_not_allowed' | 'identity_mismatch' | 'out_of_scope'
  | 'depth_exceeded' | 'not_a_question' | 'rate_limited'
  /** A stale requestId on an answer: the same 404 body as before keys, so clients tell "gone" from "refused". */
  | 'no pending permission';
export type RuleResult =
  | { ok: true }
  | { ok: false; status: 401 | 403 | 404 | 429; error: KeyErrorCode; message: string };

/** What a rule knows about the caller. `caller` is set for thread and shell keys only. */
export interface RuleCtx {
  principal: KeyPrincipal;
  caller: CallerFacts | null;
  /** Set for a plugin key: the plugin and its manifest permissions. */
  plugin: PluginFacts | null;
  scope: KeyScope;
}
export type Rule = (req: Request, ctx: RuleCtx) => RuleResult;
export interface KeyRules { thread?: Rule; roleRun?: Rule; chat?: Rule; summarizer?: Rule; shell?: Rule; plugin?: Rule }

/** A plugin rule: the key's plugin must list the permission in its manifest. */
export function needs(permission: string): Rule {
  return (_req, ctx) => (ctx.plugin?.permissions.includes(permission)
    ? { ok: true }
    : { ok: false, status: 403, error: 'owner_only', message: `The plugin "${ctx.plugin?.id ?? ctx.principal.kind}" lacks the permission "${permission}".` });
}

export type PolicyKind = 'owner' | 'key' | 'public';
export const POLICY_TAG: unique symbol = Symbol('dispatch.routePolicy');
type Tagged = Record<symbol, PolicyKind | undefined>;

export const policyKindOf = (handler: unknown): PolicyKind | undefined =>
  typeof handler === 'function' ? (handler as unknown as Tagged)[POLICY_TAG] : undefined;

function tag<T extends RequestHandler>(handler: T, kind: PolicyKind): T {
  (handler as unknown as Tagged)[POLICY_TAG] = kind;
  return handler;
}

// Rate-limited refusal lines: the first per (principal, route, error), then one per minute with a count.
const WINDOW_MS = 60_000;
let logLine: (line: string) => void = (l) => console.log(l);
let nowFn: () => number = Date.now;
const seen = new Map<string, { last: number; suppressed: number }>();

/** Test seam: redirect the refusal log and the clock, and clear the rate-limit memory. */
export function configureRefusalLog(opts: { log?: (line: string) => void; now?: () => number } = {}): void {
  logLine = opts.log ?? ((l) => console.log(l));
  nowFn = opts.now ?? Date.now;
  seen.clear();
}

function describe(p: KeyPrincipal | Extract<Principal, { kind: 'none' }>): string {
  if (p.kind === 'none') return 'keyless caller';
  if (p.kind === 'plugin') return `plugin ${p.pluginId}`;
  return p.kind === 'chat' ? `chat(${p.startedBy})` : `${p.kind} ${p.terminalId}`;
}

/** Send the refusal and log one rate-limited line. Never logs the key. */
export function refuse(res: Response, result: Extract<RuleResult, { ok: false }>): void {
  const req = res.req as Request;
  try {
    const p = principalOf(req);
    if (p.kind === 'thread' || p.kind === 'chat' || p.kind === 'shell' || p.kind === 'plugin' || p.kind === 'none') {
      const route = `${req.baseUrl ?? ''}${req.route?.path ?? ''}`;
      const id = `${p.kind === 'none' ? 'none' : p.handle}|${req.method}|${route}|${result.error}`;
      const t = nowFn();
      const e = seen.get(id);
      // The web part of a plugin names itself in X-Dispatch-Plugin (spec section 6): the log says which plugin asked.
      const tag = String(req.headers['x-dispatch-plugin'] ?? '').replace(/[^a-z0-9-]/g, '').slice(0, 64);
      const line = `[keys] refused ${describe(p)} ${req.method} ${route}: ${result.error}${tag ? ` plugin=${tag}` : ''}`;
      if (!e) {
        if (seen.size > 1000) seen.clear();
        seen.set(id, { last: t, suppressed: 0 });
        logLine(line);
      } else if (t - e.last >= WINDOW_MS) {
        logLine(`${line} (${e.suppressed + 1} more)`);
        e.last = t;
        e.suppressed = 0;
      } else {
        e.suppressed++;
      }
    }
  } catch { /* no principal: nothing to log */ }
  res.status(result.status).json({ error: result.error, message: result.message });
}

/**
 * Does this request look like it came from the Dispatch web page? A browser always sends an Origin
 * header on a POST, PATCH, PUT or DELETE and on a WebSocket upgrade, and labels a same-origin request
 * `Sec-Fetch-Site: same-origin`. A plain `curl`, a hook, a script or an agent's HTTP call sends neither.
 * This is a drift check, not a lock: a program that sets the header by hand passes, and a program that
 * can read `~/.dispatch/access-token` can sign in as the owner anyway (SEC-05, the middle option).
 */
export function looksLikeBrowser(headers: Request['headers']): boolean {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const origin = one(headers.origin);
  return (typeof origin === 'string' && origin.trim() !== '') || one(headers['sec-fetch-site']) === 'same-origin';
}

const KEYLESS_REFUSED = (req: Request): Extract<RuleResult, { ok: false }> => {
  const path = redactKeys(String(req.originalUrl ?? `${req.baseUrl ?? ''}${req.path ?? ''}`).split('?')[0]).slice(0, 200);
  return {
    ok: false, status: 401, error: 'auth_required',
    message: `${req.method} ${path} needs the owner's credential or a thread key. A call with no credential only works from the Dispatch web page for this action. ` +
      'In a thread, use the Dispatch tools (they send your key) or run "dispatch api METHOD PATH". In your own terminal, "dispatch api METHOD PATH" signs in for you. ' +
      'A script can send "Authorization: Bearer TOKEN" ("dispatch access" shows the token). This refusal covers only this action; other calls with no credential still work.',
  };
};

/**
 * SEC-05 "middle": the dangerous actions (a message or input as the user, answering a held tool call,
 * starting a thread, changing an integration) refuse a caller that has NO credential and does not look
 * like the web page. The owner (cookie, token, box) and a key that passed its own rule go on untouched.
 * Put it AFTER `keyRoute(...)` (which lets a credential-free caller through), or use `ownerOnlyStrict`.
 * A unit test that mounts a router on a bare app (`via: 'test'`) counts as the web page.
 */
export const requireOwnerProof: RequestHandler = (req, res, next) => {
  const p = principalOrNone(req);
  if (p.kind !== 'none' || p.via === 'test' || looksLikeBrowser(req.headers)) return next();
  refuse(res, KEYLESS_REFUSED(req));
};

/**
 * The request principal. When the principal middleware did not run (a unit test that mounts one
 * router on a bare Express app) the caller counts as credential-free, like `createApp`. Both app
 * builders always run the middleware first; `route-policy-completeness.test.ts` proves a key is
 * refused on a plain route of the full app.
 */
function principalOrNone(req: Request): Principal {
  try { return principalOf(req); } catch { return { kind: 'none', via: 'test' }; }
}

const KEY_LABEL: Record<string, string> = { thread: 'thread', chat: 'Chat', shell: 'shell', plugin: 'plugin' };

/**
 * The owner_only refusal. It names the method and the route, and says the refusal covers only this
 * route, so a caller does not read it as "this key may do nothing here" (a thread key may add an
 * integration but not export them). The path has no query string and no key.
 */
export function ownerOnlyResult(req: Request): Extract<RuleResult, { ok: false }> {
  let who = 'This key';
  try { who = `A ${KEY_LABEL[principalOf(req).kind] ?? 'caller'} key`; } catch { /* no principal */ }
  const path = redactKeys(String(req.originalUrl ?? `${req.baseUrl ?? ''}${req.path ?? ''}`).split('?')[0]).slice(0, 200);
  return {
    ok: false, status: 403, error: 'owner_only',
    message: `${who} cannot use ${req.method} ${path} (owner only). This refusal covers only this route; other actions may be allowed. Ask the owner to do this one in the browser.`,
  };
}

/** The owner and a credential-free local caller pass; any key gets 403 owner_only. */
export const ownerOnly: RequestHandler = tag((req, res, next) => {
  const p = principalOrNone(req);
  if (p.kind === 'owner' || p.kind === 'none') return next();
  refuse(res, ownerOnlyResult(req));
}, 'owner');

/** `ownerOnly` plus SEC-05 "middle": a credential-free caller must look like the web page (`requireOwnerProof`). */
export const ownerOnlyStrict: RequestHandler = tag((req, res, next) => {
  const p = principalOrNone(req);
  if (p.kind !== 'owner' && p.kind !== 'none') return refuse(res, ownerOnlyResult(req));
  requireOwnerProof(req, res, next);
}, 'owner');

/** Any principal passes (whoami, icons, the page). */
export const publicRoute: RequestHandler = tag((_req, _res, next) => next(), 'public');

/**
 * Owner and none pass untouched. A key picks its rule: a role-run thread key uses `roleRun`
 * (no fallback to `thread`), a summarizer Chat key uses `summarizer`, other Chat keys `chat`,
 * a shell key `shell`. A missing rule gives owner_only. A thread or shell key whose row is
 * missing or archived gives 401 auth_required.
 */
export function keyRoute(rules: KeyRules): RequestHandler {
  return tag((req, res, next) => {
    const principal = principalOrNone(req);
    if (principal.kind === 'owner' || principal.kind === 'none') return next();
    const scope = scopeOf(req);
    let caller: CallerFacts | null = null;
    let plugin: PluginFacts | null = null;
    let rule: Rule | undefined;
    if (principal.kind === 'chat') {
      rule = principal.startedBy === 'summarizer' ? rules.summarizer : rules.chat;
    } else if (principal.kind === 'plugin') {
      plugin = pluginFactsOf(principal.pluginId);
      if (!plugin) {
        return void res.status(401).json({ error: 'auth_required', message: 'This plugin key is not valid any more: the plugin is disabled or removed.' });
      }
      rule = rules.plugin;
    } else {
      caller = scope.caller(principal.terminalId);
      if (!caller || caller.archived) {
        return void res.status(401).json({ error: 'auth_required', message: 'This Dispatch key is not valid any more. Start a new thread.' });
      }
      rule = principal.kind === 'shell' ? rules.shell : caller.roleRun ? rules.roleRun : rules.thread;
    }
    if (!rule) return refuse(res, ownerOnlyResult(req));
    const result = rule(req, { principal, caller, plugin, scope });
    if (!result.ok) return refuse(res, result);
    next();
  }, 'key');
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'all'] as const;

/**
 * The policy handler of a route: its first handler after the profile guard (which `policyRouter`
 * puts in front of every route). For the completeness tests.
 */
export function policyHandlerOf(route: { stack: Array<{ handle: unknown }> }): unknown {
  return route.stack.find((l) => !isBusinessGuard(l.handle))?.handle;
}

/**
 * The ONLY way the daemon makes a router. An Express Router that:
 *   - matches paths case-sensitively and strictly (no trailing slash), so a route has one spelling
 *     (http/canonical-path.ts refuses the other spellings before they get here);
 *   - starts every route with the profile guard (profile/business-gate.ts): the business profile is
 *     decided by the route that matched, and a route with no row in the table is refused;
 *   - then prepends `ownerOnly` when the first handler carries no POLICY_TAG (default deny for keys).
 * `use` is not a route and is left alone. `http/route-registry.ts` refuses to seal an app that holds a
 * route made any other way.
 */
export function policyRouter(opts?: RouterOptions): Router {
  const router = Router({ ...opts, caseSensitive: true, strict: true });
  const raw = router as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const m of METHODS) {
    const original = raw[m].bind(router);
    raw[m] = (path: unknown, ...handlers: unknown[]) => {
      const first = handlers.flat(Infinity)[0];
      const guard = businessGuard(m.toUpperCase());
      if (handlers.length > 0 && policyKindOf(first) === undefined) return original(path, guard, ownerOnly, ...handlers);
      return original(path, guard, ...handlers);
    };
  }
  return router;
}
