// packages/core/src/profile/business-routes.ts
// THE table: every HTTP route of the daemon and what a business person may do with it.
//
// One row per registered route, keyed `METHOD /pattern` exactly as the route is registered (the mount
// path plus the route path, no trailing slash). The guard of each route (profile/business-gate.ts)
// reads its row here; a route with no row is REFUSED for a business person, and
// tests/profile/business-routes.test.ts fails until the row exists.
//
// How to classify (EXTEND HERE when you add a route):
//   allow    a business person needs it for a chat thread, a notes or file tab, their files, their
//            sign-in, their notifications, or it only takes power away (stop, archive, disable);
//   refuse   it starts or changes something that runs with approvals skipped, runs a program, adds
//            code or a tool, reads a secret or a machine detail, or belongs to a hidden feature;
//   a check  the route is needed, but only with some bodies (a chat thread yes, a shell no).
//   keys     under the business profile a thread's or a plugin's own key may use the row. Give it
//            only to what an agent needs for its work: its company tools, its status, its inbox.
//            Starting threads, messaging other threads, answering approvals, adding tools: never.
//
// The developer profile never reads this table.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import type { Request } from 'express';
import {
  ALWAYS_SMART, NO_AUTOMATIONS, NO_TERMINAL, NOT_AVAILABLE,
  both, drivable, threadCreate, unsafeConfig,
  type BusinessCheck, type BusinessRow, type KeyKind,
} from './business-gate.js';
import { expandHome } from '../sessions/project-dir.js';

const NO_WORKTREE = 'Separate working copies are not available in your workspace.';
const NO_PLUGINS = 'Adding or turning on plugins is not available in your workspace.';
const NO_SKILLS = 'Adding skills is not available in your workspace.';
const NO_INTEGRATIONS = 'Changing tool connections is not available in your workspace. Ask your administrator.';
const NO_SECRETS = 'Secrets are managed for your workspace. Ask your administrator.';
const MANAGED = 'This setting is managed for your workspace.';
const NO_CHAT = 'Chat is not available in your workspace yet. Use a chat thread instead.';
const NO_REVIEW = 'Change review is not available in your workspace.';
const NO_FOLDERS = 'In your workspace a project is made from its name. Its folder is chosen for you.';
const NO_DEVICES = 'Sign-in for other devices is not part of your workspace.';
const NO_ANALYTICS = 'Analytics are not available in your workspace.';
const NO_SECRET_DROP = 'A secret that a thread handed you is not shown in your workspace.';

const body = (req: Request): Record<string, unknown> =>
  (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) as Record<string, unknown>;

const allow = (keys?: readonly KeyKind[]): BusinessRow => ({ rule: 'allow', business: 'allow', ...(keys ? { keys } : {}) });
const refuse = (rule: string, message: string = NOT_AVAILABLE): BusinessRow => ({ rule, business: 'refuse', message });
const check = (rule: string, fn: BusinessCheck, keys?: readonly KeyKind[]): BusinessRow => ({ rule, business: fn, ...(keys ? { keys } : {}) });
/** Allowed when the thread is one a business person may drive (a chat thread, a notes or file tab). */
const onChat = (rule = 'thread.not-chat'): BusinessRow => check(rule, drivable);

const THREAD: readonly KeyKind[] = ['thread'];
const PLUGIN: readonly KeyKind[] = ['plugin'];
const AGENT: readonly KeyKind[] = ['thread', 'plugin'];

/** The folder that holds a business person's projects. */
export function businessProjectsRoot(home: string = os.homedir()): string {
  const root = path.join(home, 'projects');
  try { return fs.realpathSync(root); } catch { return root; }
}

/** `p` with every link on the way followed, as far as the path exists. */
function realAsFarAsItExists(p: string): string {
  let probe = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try { return path.join(fs.realpathSync(probe), ...rest); } catch { /* not there yet */ }
    const parent = path.dirname(probe);
    if (parent === probe) return path.resolve(p);
    rest.unshift(path.basename(probe));
    probe = parent;
  }
}

/** True when `dir` is a folder strictly inside the business projects folder (links followed). */
export function insideBusinessProjects(dir: string, root: string = businessProjectsRoot()): boolean {
  const rel = path.relative(root, realAsFarAsItExists(dir));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** POST /api/sessions: a name alone (the daemon picks `~/projects/<name>`), or a folder inside `~/projects`. */
const projectCreate: BusinessCheck = (req, facts) => {
  const given = body(req).workingDir;
  if (given === undefined || given === null || given === '') return null;
  if (typeof given !== 'string') return { message: NO_FOLDERS };
  return insideBusinessProjects(expandHome(given.trim()), facts.projectsRoot()) ? null : { message: NO_FOLDERS };
};

const smartOnly: BusinessCheck = (req) => (body(req).mode === 'smart' ? null : { message: ALWAYS_SMART });
const supervisedOnly: BusinessCheck = (req) => (body(req).mode === 'supervised' ? null : { message: ALWAYS_SMART });
const chatTransportOnly: BusinessCheck = (req) => (body(req).transport === 'structured' ? null : { message: NO_TERMINAL });
const safeConfigOnly: BusinessCheck = (req) => {
  const config = body(req).config;
  return config && typeof config === 'object' && unsafeConfig(config as Record<string, unknown>) ? { message: NO_AUTOMATIONS } : null;
};

const T = '/api/terminals/:terminalId';
const S = '/api/sessions/:id';
const L = '/api/sessions/:sessionId/ledger';
const P = '/api/plugins/:id';
const F = '/api/sessions/:id/files';

const ledgerWrite = refuse('control-plane');
const pluginChange = (rule: string) => refuse(rule, NO_PLUGINS);
const chat = refuse('chat', NO_CHAT);
const devices = refuse('devices', NO_DEVICES);
const secrets = refuse('secrets', NO_SECRETS);
const managed = refuse('settings', MANAGED);
const analytics = refuse('analytics', NO_ANALYTICS);
const review = refuse('review.diff', NO_REVIEW);

export const BUSINESS_ROUTES: Readonly<Record<string, BusinessRow>> = {
  // ── identity, launch, access ────────────────────────────────────────────────────────────────────
  'GET /api/whoami': allow(AGENT),
  'GET /api/host-context': allow(),
  'GET /api/bootstrap': allow(),
  'POST /api/access/login': allow(), // the sign-in page of a local install
  'GET /api/access/no-credential-stats': devices,
  'POST /api/access/pair-code': devices,
  'GET /api/access/devices': devices,
  'PATCH /api/access/devices/:id': devices,
  'DELETE /api/access/devices/:id': devices,
  'POST /api/access/devices/end-legacy': devices,
  'GET /api/access/addresses': devices,

  // ── company tools (os/tools-proxy.ts) and approvals (os/approvals-routes.ts) ───────────────────
  'POST /api/os/mcp/:system': allow(THREAD),
  'GET /api/os/mcp/:system': allow(THREAD),
  'DELETE /api/os/mcp/:system': allow(THREAD),
  'GET /api/os/connections': allow(),
  'POST /api/os/connections/refresh': allow(),
  'GET /api/os/tools': allow(),
  [`GET ${T}/approvals`]: allow(),
  [`POST ${T}/approvals`]: check('thread.approvals', both(smartOnly, drivable)),
  [`POST ${T}/blocked/:blockId`]: onChat(),
  [`POST ${T}/continue`]: onChat(),

  // ── projects ────────────────────────────────────────────────────────────────────────────────────
  'GET /api/chats': allow(),
  'GET /api/sessions': allow(THREAD),
  'POST /api/sessions': check('project.folder', projectCreate),
  'POST /api/sessions/reorder': allow(),
  [`GET ${S}`]: allow(),
  [`PATCH ${S}`]: allow(), // name, notes, tags (sessions/service.ts update): never the folder
  [`DELETE ${S}`]: allow(),
  [`POST ${S}/stop`]: allow(),
  [`POST ${S}/relaunch`]: refuse('project.relaunch', NO_TERMINAL), // starts a CLI in the project folder
  [`GET ${S}/cc-recent`]: allow(),
  [`GET ${S}/codex-recent`]: allow(),
  [`POST ${S}/overseer/coordinator`]: refuse('coordinator.create', NO_AUTOMATIONS),
  [`GET ${S}/overseer/coordinator`]: allow(),
  [`GET ${S}/overseer/worker-defaults`]: allow(),

  // ── threads ─────────────────────────────────────────────────────────────────────────────────────
  [`GET ${S}/terminals`]: allow(THREAD),
  [`POST ${S}/terminals`]: check('thread.create', threadCreate),
  [`GET ${S}/terminals/archived`]: allow(),
  [`POST ${S}/terminals/reorder`]: allow(),
  'GET /api/terminals/stalls': allow(),
  'POST /api/terminals/stop-all': allow(),
  'GET /api/codex/model-efforts': allow(),
  [`GET ${T}`]: allow(THREAD),
  [`PATCH ${T}`]: check('thread.config', safeConfigOnly),
  [`DELETE ${T}`]: allow(),
  [`GET ${T}/scrollback`]: refuse('thread.pty-output', NO_TERMINAL),
  // A thread key may read the owner's other threads (read_thread of the `dispatch` server); the key
  // rules (auth/key-rules.ts readRule) keep it to threads its key may read.
  [`GET ${T}/conversation`]: allow(THREAD),
  [`GET ${T}/conversation/search`]: allow(),
  // "Download thread" (2026-11-13): the same conversation as one file, so the same rule as the conversation.
  [`GET ${T}/export`]: allow(THREAD),
  [`GET ${T}/diagnostics`]: allow(),
  [`GET ${T}/status`]: allow(),
  [`GET ${T}/resume-advice`]: allow(),
  [`GET ${T}/journal`]: allow(),
  [`GET ${T}/journal/images/:imageId`]: allow(),
  // subagents-v1: a thread's subagents (read like the journal; a stop only takes power away).
  [`GET ${T}/agents`]: allow(),
  [`GET ${T}/agents/:agentId/journal`]: allow(),
  [`POST ${T}/agents/:agentId/stop`]: allow(),
  [`POST ${T}/agents/stop-all`]: allow(),
  [`POST ${T}/message`]: onChat(),
  [`GET ${T}/permission`]: allow(),
  [`POST ${T}/permission`]: onChat(),
  [`POST ${T}/autonomy`]: check('thread.autonomy', both(supervisedOnly, drivable)),
  [`POST ${T}/interrupt`]: allow(),
  [`POST ${T}/stop`]: allow(),
  [`POST ${T}/compact`]: onChat(),
  [`POST ${T}/report-status`]: allow(THREAD),
  [`POST ${T}/board`]: allow(),
  [`POST ${T}/transport`]: check('thread.transport.cli', both(chatTransportOnly, drivable)),
  [`POST ${T}/model`]: onChat(),
  [`POST ${T}/effort`]: onChat(),
  [`PATCH ${T}/account`]: onChat(),
  [`POST ${T}/input`]: refuse('thread.pty-input', NO_TERMINAL),
  [`POST ${T}/start`]: refuse('thread.start-queued', NO_AUTOMATIONS),
  [`POST ${T}/relaunch`]: onChat(),
  [`POST ${T}/reset-status`]: allow(),
  [`POST ${T}/branch`]: refuse('thread.branch'),
  [`POST ${T}/restore`]: onChat(),
  [`POST ${T}/send-file-reference`]: onChat(),
  [`PATCH ${T}/auto-archive`]: allow(),
  [`PATCH ${T}/alerts`]: allow(),
  [`POST ${T}/move`]: allow(),
  'PUT /api/terminals/:id/secrets-env': secrets,
  'POST /api/events/:provider/:terminalId': allow(THREAD), // a thread's own hook events

  // ── the decision ledger (Control Plane: hidden) ─────────────────────────────────────────────────
  [`GET ${L}/card`]: allow(),
  [`GET ${L}/:itemId/source`]: allow(),
  [`POST ${L}`]: ledgerWrite,
  [`POST ${L}/list`]: ledgerWrite,
  [`POST ${L}/note`]: ledgerWrite,
  [`POST ${L}/import`]: ledgerWrite,
  [`POST ${L}/handoff`]: ledgerWrite,
  [`POST ${L}/show`]: ledgerWrite,
  [`POST ${L}/decide-self`]: ledgerWrite,
  [`POST ${L}/:itemId/resolve`]: ledgerWrite,
  [`POST ${L}/:itemId/add-from-agent`]: ledgerWrite,
  [`POST ${L}/:itemId/decide-self`]: ledgerWrite,
  [`POST ${L}/:itemId/mark-default`]: ledgerWrite,
  [`POST ${L}/:itemId/title`]: ledgerWrite,

  // ── plugins and skills: the bundled Inbox works; nothing is added, enabled or updated ───────────
  'GET /api/plugins': allow(AGENT),
  'POST /api/plugins/scaffold': pluginChange('plugin.scaffold'),
  'POST /api/plugins/install': pluginChange('plugin.install'),
  'GET /api/plugins/marketplaces': pluginChange('plugin.marketplace'),
  'POST /api/plugins/marketplaces': pluginChange('plugin.marketplace.add'),
  'DELETE /api/plugins/marketplaces/:slug': pluginChange('plugin.marketplace'),
  'POST /api/plugins/marketplaces/:slug/pull': pluginChange('plugin.marketplace'),
  'POST /api/plugins/marketplaces/:slug/trusted': pluginChange('plugin.marketplace'),
  'GET /api/plugins/catalog': pluginChange('plugin.marketplace'),
  'GET /api/plugins/updates': pluginChange('plugin.update'),
  'POST /api/plugins/updates/check': pluginChange('plugin.update'),
  [`POST ${P}/enable`]: pluginChange('plugin.enable'),
  [`POST ${P}/disable`]: allow(),
  [`POST ${P}/reload`]: pluginChange('plugin.reload'),
  [`POST ${P}/copy`]: pluginChange('plugin.copy'),
  [`DELETE ${P}`]: allow(),
  [`GET ${P}/data`]: allow(AGENT),
  [`GET ${P}/data/:key`]: allow(AGENT),
  [`PUT ${P}/data/:key`]: allow(AGENT),
  [`DELETE ${P}/data/:key`]: allow(AGENT),
  [`GET ${P}/settings`]: allow(AGENT),
  [`PUT ${P}/settings`]: allow(AGENT),
  [`POST ${P}/files`]: allow(AGENT), // a thread hands the person a file of its own project (the Inbox)
  [`GET ${P}/files/:fileId`]: allow(),
  [`DELETE ${P}/files/:fileId`]: allow(AGENT),
  [`GET ${P}/export`]: pluginChange('plugin.export'),
  [`POST ${P}/import`]: pluginChange('plugin.import'),
  [`GET ${P}/versions`]: pluginChange('plugin.update'),
  [`POST ${P}/update`]: pluginChange('plugin.update'),
  [`POST ${P}/rollback`]: pluginChange('plugin.update'),
  [`POST ${P}/pin`]: pluginChange('plugin.update'),
  [`POST ${P}/auto-update`]: pluginChange('plugin.update'),
  [`GET ${P}/logs`]: pluginChange('plugin.logs'),
  [`POST ${P}/worker/restart`]: pluginChange('plugin.worker'),
  [`ALL ${P}/worker | ${P}/worker/*`]: pluginChange('plugin.worker'),
  [`POST ${P}/notify`]: allow(PLUGIN),
  [`GET ${P}/budget`]: allow(PLUGIN),
  [`PUT ${P}/budget`]: pluginChange('plugin.budget'),
  [`POST ${P}/assist`]: allow(PLUGIN),
  [`GET ${P}/assist/share`]: allow(PLUGIN),
  [`GET ${P}/assist/usage`]: allow(PLUGIN),
  // The Inbox for a view outside this web client (routes/inbox.ts): read one's own drops and their files,
  // mark them read, delete them. A secret's value is never shown to a business person.
  'GET /api/inbox': allow(),
  'GET /api/inbox/unread': allow(),
  'POST /api/inbox/read': allow(),
  'GET /api/inbox/drops/:dropId': allow(),
  'POST /api/inbox/drops/:dropId/read': allow(),
  'DELETE /api/inbox/drops/:dropId': allow(),
  'GET /api/inbox/drops/:dropId/files/:fileId': allow(),
  'GET /api/inbox/drops/:dropId/secret': refuse('inbox.secret', NO_SECRET_DROP),
  // Inbox → Send a secret (routes/inbox-secrets.ts): a secret for a thread to write into a file or Doppler.
  // Secrets are managed for a business workspace, so none of it is open there (yet).
  'POST /api/plugins/previews/secrets': secrets,
  'GET /api/plugins/previews/secrets': secrets,
  'DELETE /api/plugins/previews/secrets/:id': secrets,
  'POST /api/plugins/previews/secrets/use': secrets,
  'GET /api/skills': allow(AGENT),
  'POST /api/skills': refuse('skill.install', NO_SKILLS),
  'POST /api/skills/install': refuse('skill.install', NO_SKILLS),
  'DELETE /api/skills/:id': allow(),
  'POST /api/skills/:id/enable': refuse('skill.enable', NO_SKILLS),
  'POST /api/skills/:id/disable': allow(),

  // ── automations, agents, roles: list, cancel and delete; never create, change, enable or run ────
  'GET /api/agents/overview': allow(),
  'GET /api/agents/schedules': allow(),
  'POST /api/agents/schedules': refuse('automation.create', NO_AUTOMATIONS),
  'GET /api/agents/schedules/:id': allow(),
  'PATCH /api/agents/schedules/:id': refuse('automation.update', NO_AUTOMATIONS),
  'DELETE /api/agents/schedules/:id': allow(),
  'POST /api/agents/schedules/:id/run-now': refuse('automation.run', NO_AUTOMATIONS),
  'GET /api/agents/runs': allow(),
  'GET /api/agents/runs/:id': allow(),
  'GET /api/agents/runs/:id/events': allow(),
  'POST /api/agents/runs/:id/opened': allow(),
  'POST /api/agents/runs/:id/cancel': allow(),
  'GET /api/roles': allow(),
  'POST /api/roles/:name/enable': refuse('role.enable', NO_AUTOMATIONS),
  'POST /api/roles/:name/disable': allow(),
  'POST /api/watches': refuse('watch.create', NO_AUTOMATIONS),
  'GET /api/watches': allow(),
  'DELETE /api/watches/:id': allow(),
  'GET /api/outbox': allow(),

  // ── settings: read what the page shows; the machine's settings are managed ──────────────────────
  'GET /api/providers': allow(),
  'GET /api/servers': allow(),
  'POST /api/servers': managed,
  'DELETE /api/servers': managed,
  'GET /api/secrets/status': allow(),
  'PUT /api/secrets/connection': secrets,
  'DELETE /api/secrets/connection': secrets,
  'GET /api/secrets/projects': secrets,
  'GET /api/secrets/configs': secrets,
  'GET /api/secrets': secrets,
  'POST /api/secrets': secrets,
  'GET /api/secrets/:name/value': secrets,
  'DELETE /api/secrets/:name': secrets,
  'GET /api/settings/harnesses': allow(),
  'PUT /api/settings/harnesses': managed,
  'GET /api/settings/harnesses/opencode/catalog': allow(),
  'PUT /api/settings/harnesses/overseer-workers': managed,
  'GET /api/settings/telemetry': allow(),
  'PUT /api/settings/telemetry': managed,
  'GET /api/settings/dictation': allow(),
  'PUT /api/settings/dictation': managed,
  'GET /api/settings/coordinator': allow(),
  'PUT /api/settings/coordinator': managed,
  'GET /api/settings/usage-limits': allow(),
  'PUT /api/settings/usage-limits': managed,
  'POST /api/transcribe': allow(), // voice input in the composer
  'GET /api/setup/harnesses': allow(),
  'GET /api/setup/state': allow(),
  'GET /api/setup/providers': allow(),
  'GET /api/setup/tailscale': managed,
  'POST /api/setup/complete': allow(),
  'POST /api/setup/install/:provider': refuse('setup.install'), // runs an installer on the machine
  'GET /api/integrations': allow(), // every header and env value is masked
  'POST /api/integrations': refuse('integration.create', NO_INTEGRATIONS),
  'PATCH /api/integrations/:id': refuse('integration.update', NO_INTEGRATIONS),
  'DELETE /api/integrations/:id': refuse('integration.delete', NO_INTEGRATIONS),
  'GET /api/integrations/export': refuse('integration.export', NO_INTEGRATIONS),
  'POST /api/integrations/import': refuse('integration.import', NO_INTEGRATIONS),
  'GET /api/tools': allow(),
  'PUT /api/appearance/icons': allow(),

  // ── files (routes/files.ts checks every path against the person's folders: files/path-policy.ts) ─
  [`GET ${F}`]: allow(),
  [`GET ${F}/flat`]: allow(),
  [`GET ${F}/read`]: allow(),
  [`GET ${F}/image`]: allow(),
  [`GET ${F}/download`]: allow(),
  [`POST ${F}/reveal`]: refuse('files.reveal'), // opens a file manager on the machine
  [`PUT ${F}/write`]: allow(),
  [`POST ${F}/upload`]: allow(),
  [`POST ${F}/inbox`]: allow(),
  [`POST ${F}/mkdir`]: allow(),
  [`POST ${F}/rename`]: allow(),
  [`DELETE ${F}`]: allow(),
  [`GET ${S}/git`]: allow(),
  [`GET ${S}/git/status`]: allow(),
  [`GET ${S}/git/diff`]: review,
  [`POST ${S}/git/approve`]: review,
  [`POST ${S}/git/discard`]: review,
  [`GET ${S}/worktrees`]: allow(),
  [`POST ${S}/worktrees`]: refuse('worktree.create', NO_WORKTREE),
  [`POST ${S}/worktrees/remove`]: allow(),
  'GET /api/state/last-directory': allow(),
  'GET /api/state/active-session': allow(),
  'POST /api/state/active-session': allow(),
  'GET /api/state/browse': refuse('files.browse', NO_FOLDERS), // lists any folder of the machine
  'POST /api/state/mkdir': refuse('files.browse', NO_FOLDERS), // makes a folder anywhere
  'GET /api/state/session-stats/:sessionId': allow(),
  'GET /api/state/terminal-status/:terminalId': allow(),
  'GET /api/state/update': allow(),
  'GET /api/state/tailscale': managed,
  'GET /api/state/status-quality': allow(),
  'GET /api/state/host': allow(),

  // ── sign-in and accounts ────────────────────────────────────────────────────────────────────────
  'GET /api/auth-requests': allow(),
  'POST /api/auth-requests': allow(THREAD), // a CLI asks the person to open a sign-in link
  'POST /api/auth-requests/complete-all': allow(),
  'POST /api/auth-requests/:id/opened': allow(),
  'POST /api/auth-requests/:id/complete': allow(),
  'POST /api/auth-requests/:id/callback': allow(),
  'GET /api/claude-auth': allow(),
  'POST /api/claude-auth/login': allow(),
  'POST /api/claude-auth/login/code': allow(),
  'POST /api/claude-auth/login/cancel': allow(),
  'DELETE /api/claude-auth': allow(),
  'GET /api/accounts': allow(),
  'PATCH /api/accounts/:provider/:id': allow(),
  'GET /api/accounts/:provider/:id/threads': allow(),
  'POST /api/accounts/claude/login': allow(),
  'POST /api/accounts/claude/:id/check': allow(),
  'POST /api/accounts/codex': allow(),
  'POST /api/accounts/codex/:id/login': allow(),
  'GET /api/accounts/codex/:id/login': allow(),
  'DELETE /api/accounts/codex/:id/login': allow(),
  'PUT /api/accounts/:provider/default': allow(),
  'DELETE /api/accounts/:provider/:id': allow(),

  // ── notifications, updates, usage ───────────────────────────────────────────────────────────────
  'GET /api/push/key': allow(),
  'POST /api/push/subscribe': allow(),
  'GET /api/push/subscriptions': allow(),
  'DELETE /api/push/subscriptions/:deviceId': allow(),
  'POST /api/push/unsubscribe': allow(),
  'POST /api/push/presence': allow(),
  'GET /api/update/progress': allow(),
  'POST /api/update/check': allow(),
  'POST /api/update/apply': allow(), // hosted: asks the platform to move the workspace to the new image
  'GET /api/usage-limits': allow(),
  'GET /api/usage-limits/summary': allow(),
  'POST /api/usage-limits/refresh': allow(),
  'POST /api/usage-limits/reset-credit': managed,
  'GET /api/analytics/summary': analytics,
  'GET /api/analytics/series': analytics,
  'GET /api/analytics/top': analytics,
  'GET /api/analytics/records': analytics,
  'GET /api/analytics/control-plane': analytics,
  'GET /api/analytics/tracking': analytics,

  // ── Chat ("Endless"): its turns run a harness with every tool allowed, so it stays off ──────────
  'GET /api/endless/state': allow(),
  'GET /api/endless/messages': allow(),
  'POST /api/endless/stop': allow(),
  'POST /api/endless/send': chat,
  'POST /api/endless/retry': chat,
  'GET /api/endless/search': chat,
  'GET /api/endless/view': chat,
  'GET /api/endless/projects': chat,
  'GET /api/endless/doc': chat,
  'GET /api/endless/docs': chat,
  'GET /api/endless/docs/counts': chat,
  'GET /api/endless/threads': chat,
  'GET /api/endless/project': chat,
  'POST /api/endless/arm': chat,
  'POST /api/endless/disarm': chat,
  'POST /api/endless/ledger/:action': chat,
  'GET /api/endless/zoom': chat,
  'GET /api/endless/date': chat,
  'GET /api/endless/instructions': chat,
  'PUT /api/endless/instructions': chat,
  'GET /api/endless/settings': allow(),
  'PUT /api/endless/settings': chat,
  'GET /api/endless/media/:name': chat,

  // ── the page itself ─────────────────────────────────────────────────────────────────────────────
  'GET /plugins/:id/*': allow(),
  'GET /icons/:name': allow(),
  'GET (page)': allow(), // the web client's index.html for every path that is not /api
};
