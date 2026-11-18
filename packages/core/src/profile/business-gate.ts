// packages/core/src/profile/business-gate.ts
// What a person on the BUSINESS profile may do, enforced by the daemon.
//
// The web page hides features for a business person (packages/web/src/lib/profile.ts). Hiding is not
// enforcement, so the daemon decides too. How it decides (2026-11-12):
//
//   1. DEFAULT DENY. Every HTTP route and every WebSocket of the daemon has one row in the table of
//      profile/business-routes.ts: `allow`, `refuse`, or a check of the body. A route with no row is
//      refused for a business person at run time, and fails a unit test.
//   2. THE MATCHED ROUTE decides, never the text of the URL. The guard is the first handler of each
//      route (auth/route-policy.ts puts it there), so it runs only when the router has matched that
//      route, and it looks its row up by the route object. No spelling of a path can reach a handler
//      without passing the guard of that very handler.
//   3. A KEY held by a thread, a shell, Chat or a plugin is not the person. Under the business profile
//      a key may use only the rows marked for it (`keys`): what an agent needs to do its work.
//
// In the developer profile this file does nothing.
import type { Request, RequestHandler } from 'express';
import { harnessCapabilities } from '../providers/capabilities.js';
import { isPtyType } from '../db/terminals.js';
import type { Profile } from './host-context.js';

export const BUSINESS_DENIED_ERROR = 'not_available_in_profile';

/** A refusal: the plain sentence for the page. */
export interface Denial { message: string }

/** What a check may ask about the request's thread and project (the daemon's own records). */
export interface GateFacts {
  /** The saved type and config of a thread, or null when there is no such thread. */
  thread(id: string): { type: string; config: Record<string, unknown> } | null;
  /** The folder that holds a business person's projects (`~/projects`), as a real path. */
  projectsRoot(): string;
}

export type BusinessCheck = (req: Request, facts: GateFacts) => Denial | null;

/** Who, besides the person, may use a row under the business profile. */
export type KeyKind = 'thread' | 'plugin';

export interface BusinessRow {
  /** A short name, for the answer's `rule`, the audit list and the tests. */
  rule: string;
  business: 'allow' | 'refuse' | BusinessCheck;
  /** The sentence of a plain `refuse`. */
  message?: string;
  /** Keys that may use the row under the business profile. Absent: the person only. */
  keys?: readonly KeyKind[];
}

export const NOT_AVAILABLE = 'This is not available in your workspace.';
export const NO_TERMINAL = 'Terminal threads are not available in your workspace. Start a chat thread instead.';
export const NO_BROWSER = 'Browser threads are not available in your workspace.';
export const ALWAYS_SMART = 'In your workspace, risky actions always ask first.';
export const NO_AUTOMATIONS = 'Automations and agents that run on their own are not available in your workspace yet. Ask in a chat thread instead.';
export const NOT_A_CHAT = 'This thread is not a chat thread. Start a new chat thread instead.';
export const AGENT_REFUSED = 'An agent cannot do this in this workspace. Ask the person to do it.';
export const NO_HARNESS = 'This assistant is not available in your workspace. Start a Claude Code chat thread instead.';

/**
 * The harnesses a business person may chat with. Claude Code, and Codex (which the platform gates on
 * its side). OpenCode is not one: a file the agent writes in the project (`opencode.json`, a plugin in
 * `.opencode/`) replaces the thread's approval rules or runs as code at the next start, and the
 * business rules let the agent edit project files without a question.
 */
export const BUSINESS_HARNESSES: readonly string[] = ['claude-code', 'codex'];

/**
 * A thread config that would run a harness with approvals skipped or by itself: an agent or runner
 * thread (the runner command skips every approval), a role, a coordinator, the autonomous dial,
 * approvals other than `smart`, the CLI, or a sign-in shell.
 */
export function unsafeConfig(config: Record<string, unknown>): boolean {
  return !!(config.role || config.runner || config.runnerPrompt || config.agentType || config.roleAuthority || config.roleRun)
    || config.autonomy === 'autonomous'
    || (config.approvals !== undefined && config.approvals !== 'smart')
    || config.transport === 'pty'
    || config.signIn !== undefined
    || config.queued === true || config.queuedTask !== undefined
    || config.branchFrom !== undefined;
}

/** True when the harness has a structured (chat) transport on this daemon. */
function hasChatTransport(type: string): boolean {
  const cap = harnessCapabilities().find((h) => h.type === type);
  return !!cap && cap.modes.includes('pretty');
}

/**
 * True when a saved thread is one a business person may drive: a notes or file tab, or a harness on
 * the chat transport with no role and no skipped approvals. A shell, a browser tab, a CLI thread, an
 * agent, a runner or a coordinator (made while the person was a developer) is not.
 */
export function businessMayDrive(thread: { type: string; config: Record<string, unknown> }): boolean {
  if (thread.type === 'notes' || thread.type === 'file') return true;
  if (thread.type === 'shell' || thread.type === 'browser') return false;
  if (!isPtyType(thread.type) || !BUSINESS_HARNESSES.includes(thread.type)) return false;
  return thread.config.transport === 'structured' && !unsafeConfig(thread.config);
}

/**
 * POST /api/sessions/:id/terminals. A business person gets chat threads and notes/file tabs only:
 *   - `shell` (including the CLI sign-in shell) and `browser`: refused;
 *   - a harness other than BUSINESS_HARNESSES (OpenCode, for one): refused;
 *   - a harness with no structured transport, or one asked for as a CLI (transport 'pty'): refused;
 *   - a harness with no transport named: made structured, the chat form.
 * A new chat thread is saved with `approvals: 'smart'` (os/approvals.ts).
 */
export const threadCreate: BusinessCheck = (req) => {
  const body = (req.body ?? {}) as { type?: unknown; config?: Record<string, unknown> | null };
  const type = typeof body.type === 'string' ? body.type : '';
  if (type === 'shell') return { message: NO_TERMINAL };
  if (type === 'browser') return { message: NO_BROWSER };
  if (!isPtyType(type)) return null; // notes, file, or an invalid type (the route answers 400 for that)
  if (!BUSINESS_HARNESSES.includes(type)) return { message: NO_HARNESS };
  const config = body.config && typeof body.config === 'object' && !Array.isArray(body.config) ? body.config : {};
  if (config.transport === 'pty' || !hasChatTransport(type)) return { message: NO_TERMINAL };
  // An agent, runner, role or autonomous thread, or a queued agent: it would run with approvals off.
  if ((body as { queued?: unknown }).queued || unsafeConfig(config)) return { message: NO_AUTOMATIONS };
  config.transport = 'structured';
  config.approvals = 'smart';
  body.config = config;
  req.body = body;
  return null;
};

/** A row whose thread (`:terminalId` or `:id`) must be one a business person may drive. An unknown id goes on: the route answers 404. */
export const drivable: BusinessCheck = (req, facts) => {
  const id = String(req.params.terminalId ?? req.params.id ?? '');
  const thread = id ? facts.thread(id) : null;
  return thread && !businessMayDrive(thread) ? { message: NOT_A_CHAT } : null;
};

/** Both checks: the first refusal wins. */
export const both = (...checks: BusinessCheck[]): BusinessCheck => (req, facts) => {
  for (const c of checks) { const d = c(req, facts); if (d) return d; }
  return null;
};

/** A profile, or a function that reads the live one (os/profile.ts). */
export type ProfileSource = Profile | (() => Profile);

function read(profile: ProfileSource): Profile {
  return typeof profile === 'function' ? profile() : profile;
}

// ── the route guard ──────────────────────────────────────────────────────────────────────────────────

/** What the guard reads from `app.locals` (set by `installBusinessGate`). */
export interface BusinessGateState {
  profile: ProfileSource;
  /** `METHOD /pattern` → row. */
  table: Readonly<Record<string, BusinessRow>>;
  /** The route pattern of each registered route (filled by `sealRoutes`). */
  ids: WeakMap<object, string>;
  facts: GateFacts;
  /** The kind of key the request carries, or null for the person (and for a caller with no key). */
  keyKind: (req: Request) => 'thread' | 'plugin' | 'chat' | 'shell' | null;
}

export const GATE_LOCAL = 'businessGate';
const GUARD = Symbol('dispatch.businessGuard');

export const isBusinessGuard = (handler: unknown): boolean =>
  typeof handler === 'function' && (handler as unknown as Record<symbol, unknown>)[GUARD] === true;

/** The decision for one matched route. Exported for the tests and for audits. */
export function businessVerdict(
  state: BusinessGateState, method: string, routeId: string | undefined, req: Request,
): { rule: string; message: string } | null {
  const m = method === 'HEAD' ? 'GET' : method;
  const row = routeId === undefined ? undefined : state.table[`${m} ${routeId}`] ?? state.table[`ALL ${routeId}`];
  if (!row) return { rule: 'unclassified', message: NOT_AVAILABLE };
  const key = state.keyKind(req);
  if (key !== null) {
    // Chat and shell keys have no row of their own: neither exists for a business person.
    const kind: KeyKind | null = key === 'thread' ? 'thread' : key === 'plugin' ? 'plugin' : null;
    if (kind === null || !row.keys?.includes(kind)) return { rule: 'agent-key', message: AGENT_REFUSED };
  }
  if (row.business === 'allow') return null;
  if (row.business === 'refuse') return { rule: row.rule, message: row.message ?? NOT_AVAILABLE };
  const denial = row.business(req, state.facts);
  return denial ? { rule: row.rule, message: denial.message } : null;
}

/**
 * The first handler of every route (auth/route-policy.ts adds it at registration). `method` is the
 * method the route was registered for. With no gate on the app (a unit test that mounts one router
 * on a bare Express app) or in the developer profile it passes.
 */
export function businessGuard(method: string): RequestHandler {
  const guard: RequestHandler = (req, res, next) => {
    const state = (req.app?.locals as Record<string, unknown> | undefined)?.[GATE_LOCAL] as BusinessGateState | undefined;
    if (!state || read(state.profile) !== 'business') return next();
    const route = (req as unknown as { route?: object }).route;
    const hit = businessVerdict(state, method === 'ALL' ? req.method.toUpperCase() : method, route ? state.ids.get(route) : undefined, req);
    if (!hit) return next();
    // `error` is the sentence the page shows (api/client.ts shows a body's `error`); `code` is for programs.
    res.status(403).json({ error: hit.message, code: BUSINESS_DENIED_ERROR, rule: hit.rule });
  };
  (guard as unknown as Record<symbol, unknown>)[GUARD] = true;
  return guard;
}

// ── WebSockets ───────────────────────────────────────────────────────────────────────────────────────

export interface SocketRoute {
  id: 'events' | 'structured' | 'terminal' | 'terminal-legacy';
  /** Matched against the PATH (no query, mount prefix stripped), anchored at both ends. */
  path: RegExp;
  business: 'allow' | 'refuse';
}

/**
 * EVERY WebSocket of the daemon (daemon/sockets.ts routes by this table and by nothing else). The PTY
 * terminal sockets are refused for a business person. A path that matches no row opens no socket.
 */
export const SOCKET_ROUTES: readonly SocketRoute[] = [
  { id: 'events', path: /^\/api\/events$/, business: 'allow' },
  { id: 'structured', path: /^\/api\/terminals\/([^/]+)\/structured-ws$/, business: 'allow' },
  { id: 'terminal', path: /^\/api\/terminals\/([^/]+)\/ws$/, business: 'refuse' },
  { id: 'terminal-legacy', path: /^\/api\/sessions\/([^/]+)\/terminal$/, business: 'refuse' },
];

/** The socket a path names, with its id parameter; null when it names none. */
export function socketRouteOf(url: string): { route: SocketRoute; param: string | null } | null {
  const q = url.indexOf('?');
  const p = q === -1 ? url : url.slice(0, q);
  for (const route of SOCKET_ROUTES) {
    const m = route.path.exec(p);
    if (m) return { route, param: m[1] ?? null };
  }
  return null;
}

/** For the upgrade handler: may this profile open the socket of `route`? Null (no such socket): no. */
export function socketAllowedForProfile(profile: ProfileSource, route: SocketRoute | null, thread?: { type: string; config: Record<string, unknown> } | null): boolean {
  if (!route) return false;
  if (read(profile) !== 'business') return true;
  if (route.business !== 'allow') return false;
  // The chat stream of a thread a business person may not drive (an agent, a CLI thread) stays closed:
  // opening it would start that thread's process again.
  if (route.id === 'structured' && thread && !businessMayDrive(thread)) return false;
  return true;
}
