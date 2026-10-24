import { Router, type Request, type RequestHandler, type Response, type RouterOptions } from 'express';
import { principalOf, scopeOf, type Principal } from './request-principal.js';
import type { KeyPrincipal } from './principals.js';
import type { CallerFacts, KeyScope } from './key-scope.js';

/**
 * Route policy (spec 6.4). Default deny: a route with no key policy is owner only.
 * Every route handler chain starts with a tagged handler (`ownerOnly`, `keyRoute(...)`
 * or `publicRoute`); `policyRouter()` adds `ownerOnly` for a route that has none.
 */
export type KeyErrorCode = 'owner_only' | 'field_not_allowed' | 'identity_mismatch' | 'out_of_scope'
  | 'depth_exceeded' | 'not_a_question' | 'rate_limited'
  /** A stale requestId on an answer: the same 404 body as before keys, so clients tell "gone" from "refused". */
  | 'no pending permission';
export type RuleResult =
  | { ok: true }
  | { ok: false; status: 403 | 404 | 429; error: KeyErrorCode; message: string };

/** What a rule knows about the caller. `caller` is set for thread and shell keys only. */
export interface RuleCtx {
  principal: KeyPrincipal;
  caller: CallerFacts | null;
  scope: KeyScope;
}
export type Rule = (req: Request, ctx: RuleCtx) => RuleResult;
export interface KeyRules { thread?: Rule; roleRun?: Rule; chat?: Rule; summarizer?: Rule; shell?: Rule }

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

function describe(p: KeyPrincipal): string {
  return p.kind === 'chat' ? `chat(${p.startedBy})` : `${p.kind} ${p.terminalId}`;
}

/** Send the refusal and log one rate-limited line. Never logs the key. */
export function refuse(res: Response, result: Extract<RuleResult, { ok: false }>): void {
  const req = res.req as Request;
  try {
    const p = principalOf(req);
    if (p.kind === 'thread' || p.kind === 'chat' || p.kind === 'shell') {
      const route = `${req.baseUrl ?? ''}${req.route?.path ?? ''}`;
      const id = `${p.handle}|${req.method}|${route}|${result.error}`;
      const t = nowFn();
      const e = seen.get(id);
      const line = `[keys] refused ${describe(p)} ${req.method} ${route}: ${result.error}`;
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
 * The request principal. When the principal middleware did not run (a unit test that mounts one
 * router on a bare Express app) the caller counts as credential-free, like `createApp`. Both app
 * builders always run the middleware first; `route-policy-completeness.test.ts` proves a key is
 * refused on a plain route of the full app.
 */
function principalOrNone(req: Request): Principal {
  try { return principalOf(req); } catch { return { kind: 'none', via: 'test' }; }
}

const OWNER_ONLY: Extract<RuleResult, { ok: false }> = {
  ok: false, status: 403, error: 'owner_only',
  message: 'This action is for the owner only. Ask the owner to do it in the browser.',
};

/** The owner and a credential-free local caller pass; any key gets 403 owner_only. */
export const ownerOnly: RequestHandler = tag((req, res, next) => {
  const p = principalOrNone(req);
  if (p.kind === 'owner' || p.kind === 'none') return next();
  refuse(res, OWNER_ONLY);
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
    let rule: Rule | undefined;
    if (principal.kind === 'chat') {
      rule = principal.startedBy === 'summarizer' ? rules.summarizer : rules.chat;
    } else {
      caller = scope.caller(principal.terminalId);
      if (!caller || caller.archived) {
        return void res.status(401).json({ error: 'auth_required', message: 'This Dispatch key is not valid any more. Start a new thread.' });
      }
      rule = principal.kind === 'shell' ? rules.shell : caller.roleRun ? rules.roleRun : rules.thread;
    }
    if (!rule) return refuse(res, OWNER_ONLY);
    const result = rule(req, { principal, caller, scope });
    if (!result.ok) return refuse(res, result);
    next();
  }, 'key');
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'all'] as const;

/**
 * An Express Router whose `get`, `post`, `put`, `patch`, `delete` and `all` prepend `ownerOnly`
 * when the first handler carries no POLICY_TAG. `use` is not a route and is left alone.
 */
export function policyRouter(opts?: RouterOptions): Router {
  const router = Router(opts);
  const raw = router as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const m of METHODS) {
    const original = raw[m].bind(router);
    raw[m] = (path: unknown, ...handlers: unknown[]) => {
      const first = handlers.flat(Infinity)[0];
      if (handlers.length > 0 && policyKindOf(first) === undefined) return original(path, ownerOnly, ...handlers);
      return original(path, ...handlers);
    };
  }
  return router;
}
