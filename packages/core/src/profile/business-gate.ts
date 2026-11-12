// packages/core/src/profile/business-gate.ts
// What a person on the BUSINESS profile may not do, enforced by the daemon.
//
// The web page hides these features for a business person (packages/web/src/lib/profile.ts). Hiding
// is not enforcement: a person (or a page from an older build) can still call the route. So the
// daemon refuses them too, here, in ONE list, so the list can be read and audited in one place:
// BUSINESS_RULES below, and BUSINESS_UPGRADE_DENY for the WebSockets.
//
// The rules are about the features, not about reading: every GET stays allowed, so a business person
// still sees the threads, files and data that exist. A refusal is a 403 with a plain message the page
// can show as it is. In the developer profile this file does nothing.
import type { Request, RequestHandler } from 'express';
import { harnessCapabilities } from '../providers/capabilities.js';
import { isPtyType } from '../db/terminals.js';
import type { Profile } from './host-context.js';

export const BUSINESS_DENIED_ERROR = 'not_available_in_profile';

/** A refusal: the plain sentence for the page. */
export interface Denial { message: string }

export interface BusinessRule {
  /** A short name, for the audit list and the tests. */
  id: string;
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Matched against the path with no mount prefix and no query (`/api/...`). */
  path: RegExp;
  /**
   * Decide one request. Null: allowed. A rule may also correct the body of an allowed request (the
   * thread-create rule makes a new chat thread structured and supervised), so the route after it
   * creates what a business person is allowed to have.
   */
  check: (req: Request) => Denial | null;
}

const deny = (message: string) => (): Denial => ({ message });

const NO_TERMINAL = 'Terminal threads are not available in your workspace. Start a chat thread instead.';
const NO_BROWSER = 'Browser threads are not available in your workspace.';
const NO_WORKTREE = 'Separate working copies are not available in your workspace.';
const NO_PLUGINS = 'Adding or turning on plugins is not available in your workspace.';
const NO_SKILLS = 'Adding skills is not available in your workspace.';
const NO_INTEGRATIONS = 'Changing tool connections is not available in your workspace. Ask your administrator.';
const ALWAYS_SMART = 'In your workspace, risky actions always ask first.';

/** True when the harness has a structured (chat) transport on this daemon. */
function hasChatTransport(type: string): boolean {
  const cap = harnessCapabilities().find((h) => h.type === type);
  return !!cap && cap.modes.includes('pretty');
}

/**
 * POST /api/sessions/:id/terminals. A business person gets chat threads and notes/file tabs only:
 *   • `shell` (including the CLI sign-in shell) and `browser`: refused;
 *   • a harness with no structured transport, or one asked for as a CLI (transport 'pty'): refused;
 *   • a harness with no transport named: made structured, the chat form.
 * A new PLAIN chat thread (no role, runner or role authority) is saved with `approvals: 'smart'`
 * (os/approvals.ts): a business person's threads are always smart. A thread with a role keeps its
 * own membrane.
 */
function threadCreate(req: Request): Denial | null {
  const body = (req.body ?? {}) as { type?: unknown; config?: Record<string, unknown> | null };
  const type = typeof body.type === 'string' ? body.type : '';
  if (type === 'shell') return { message: NO_TERMINAL };
  if (type === 'browser') return { message: NO_BROWSER };
  if (!isPtyType(type)) return null; // notes, file, or an invalid type (the route answers 400 for that)
  const config = body.config && typeof body.config === 'object' ? body.config : {};
  if (config.transport === 'pty' || !hasChatTransport(type)) return { message: NO_TERMINAL };
  config.transport = 'structured';
  const plain = !config.role && !config.runner && !config.roleAuthority;
  if (plain) config.approvals = 'smart';
  body.config = config;
  req.body = body;
  return null;
}

/**
 * EXTEND HERE: one row per refused route. Keep the paths anchored. A GET never goes here.
 */
export const BUSINESS_RULES: readonly BusinessRule[] = [
  // Threads: no terminal, no browser, no CLI.
  { id: 'thread.create', method: 'POST', path: /^\/api\/sessions\/[^/]+\/terminals\/?$/, check: threadCreate },
  {
    id: 'thread.transport.cli', method: 'POST', path: /^\/api\/terminals\/[^/]+\/transport\/?$/,
    check: (req) => ((req.body as { transport?: unknown } | undefined)?.transport === 'structured' ? null : { message: NO_TERMINAL }),
  },
  // Raw keystrokes into a PTY (the CLI form of a thread).
  { id: 'thread.pty-input', method: 'POST', path: /^\/api\/terminals\/[^/]+\/input\/?$/, check: deny(NO_TERMINAL) },
  // Approvals: a business person's chat threads stay `smart` (os/approvals-routes.ts).
  {
    id: 'thread.approvals', method: 'POST', path: /^\/api\/terminals\/[^/]+\/approvals\/?$/,
    check: (req) => ((req.body as { mode?: unknown } | undefined)?.mode === 'smart' ? null : { message: ALWAYS_SMART }),
  },
  // Worktrees: making one. Listing them and removing one stay allowed.
  { id: 'worktree.create', method: 'POST', path: /^\/api\/sessions\/[^/]+\/worktrees\/?$/, check: deny(NO_WORKTREE) },
  // Plugins: install, enable, create, import, copy, update, roll back, add a marketplace.
  // Disable and remove stay allowed: they take power away, they do not add it.
  { id: 'plugin.install', method: 'POST', path: /^\/api\/plugins\/install\/?$/, check: deny(NO_PLUGINS) },
  { id: 'plugin.scaffold', method: 'POST', path: /^\/api\/plugins\/scaffold\/?$/, check: deny(NO_PLUGINS) },
  { id: 'plugin.enable', method: 'POST', path: /^\/api\/plugins\/[^/]+\/enable\/?$/, check: deny(NO_PLUGINS) },
  { id: 'plugin.import', method: 'POST', path: /^\/api\/plugins\/[^/]+\/import\/?$/, check: deny(NO_PLUGINS) },
  { id: 'plugin.copy', method: 'POST', path: /^\/api\/plugins\/[^/]+\/copy\/?$/, check: deny(NO_PLUGINS) },
  { id: 'plugin.update', method: 'POST', path: /^\/api\/plugins\/[^/]+\/(update|rollback)\/?$/, check: deny(NO_PLUGINS) },
  { id: 'plugin.marketplace.add', method: 'POST', path: /^\/api\/plugins\/marketplaces\/?$/, check: deny(NO_PLUGINS) },
  { id: 'skill.install', method: 'POST', path: /^\/api\/skills(\/install)?\/?$/, check: deny(NO_SKILLS) },
  // Integrations (MCP servers): create, change, delete, import.
  { id: 'integration.create', method: 'POST', path: /^\/api\/integrations\/?$/, check: deny(NO_INTEGRATIONS) },
  { id: 'integration.import', method: 'POST', path: /^\/api\/integrations\/import\/?$/, check: deny(NO_INTEGRATIONS) },
  { id: 'integration.update', method: 'PATCH', path: /^\/api\/integrations\/[^/]+\/?$/, check: deny(NO_INTEGRATIONS) },
  { id: 'integration.delete', method: 'DELETE', path: /^\/api\/integrations\/[^/]+\/?$/, check: deny(NO_INTEGRATIONS) },
];

/** WebSockets a business person may not open: the PTY terminal sockets (daemon/sockets.ts). */
export const BUSINESS_UPGRADE_DENY: readonly RegExp[] = [
  /^\/api\/terminals\/[^/]+\/ws(\?|$)/,
  /^\/api\/sessions\/[^/]+\/terminal(\?|\/|$)/,
];

/** The rule that refuses this request, or null. Exported for the tests and for audits. */
export function businessDecision(req: Request): { rule: BusinessRule; denial: Denial } | null {
  const method = req.method.toUpperCase();
  const path = req.path;
  for (const rule of BUSINESS_RULES) {
    if (rule.method !== method || !rule.path.test(path)) continue;
    const denial = rule.check(req);
    if (denial) return { rule, denial };
  }
  return null;
}

/** A profile, or a function that reads the live one (os/profile.ts). */
export type ProfileSource = Profile | (() => Profile);

function read(profile: ProfileSource): Profile {
  return typeof profile === 'function' ? profile() : profile;
}

/**
 * The middleware, mounted once in front of every /api route (server-routes.ts). It reads the profile
 * on EVERY request, so a change from OS applies at once. Developer: passes everything.
 */
export function businessProfileGate(profile: ProfileSource): RequestHandler {
  return (req, res, next) => {
    if (read(profile) !== 'business') return next();
    const hit = businessDecision(req);
    if (!hit) return next();
    // `error` is the sentence the page shows (api/client.ts shows a body's `error`); `code` is for programs.
    res.status(403).json({ error: hit.denial.message, code: BUSINESS_DENIED_ERROR, rule: hit.rule.id });
  };
}

/** For the upgrade handler: may this profile open a WebSocket at `url` (mount prefix already stripped)? */
export function upgradeAllowedForProfile(profile: ProfileSource, url: string): boolean {
  if (read(profile) !== 'business') return true;
  return !BUSINESS_UPGRADE_DENY.some((re) => re.test(url));
}
