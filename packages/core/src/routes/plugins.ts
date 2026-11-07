import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { Router, RequestHandler, Request } from 'express';
import { policyRouter, publicRoute, ownerOnlyStrict, keyRoute, needs, type Rule } from '../auth/route-policy.js';
import { principalOf, scopeOf } from '../auth/request-principal.js';
import * as pluginData from '../db/plugin-data.js';
import { projectListRule, allowRule } from '../auth/key-rules.js';
import { setFileHeaders, HTML_SANDBOX_CSP } from '../http/active-content.js';
import { insideRealRoot } from '../files/confine.js';
import * as sessionsDb from '../db/sessions.js';
import { checkProjectFile, ProjectFileError, PROJECT_FILE_MIME } from '../plugins/files.js';
import type { PluginRegistry } from '../plugins/registry.js';
import type { AssistRunner } from '../assist/run.js';
import type { PluginWorkers } from '../plugins/workers.js';
import type { MarketplaceService } from '../plugins/marketplaces.js';
import type { PluginInstaller } from '../plugins/installer.js';
import type { SkillsService } from '../plugins/skills.js';

/**
 * Plugins (docs/superpowers/specs/2026-11-07-plugins-design.md): the manifests, the owner's
 * actions on local plugins, and the plugin files the web client imports.
 */
function fail(res: import('express').Response, e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  const status = msg === 'unknown plugin' ? 404 : msg === 'exists' ? 409 : msg === 'bad id' || msg === 'not local' || msg === 'bundled' ? 400 : 500;
  res.status(status).json({ error: msg });
}

const OK = { ok: true } as const;
export const ASSIST_INFLIGHT_MAX = 3;

/** A plugin key reaches the storage and settings of its own plugin only. */
const ownPluginRule: Rule = (req, ctx) => (ctx.plugin?.id === req.params.id
  ? OK
  : { ok: false, status: 403, error: 'out_of_scope', message: 'A plugin reaches its own storage only.' });

/** A thread reaches a plugin's documents only when the plugin granted threads that access (spec section 5). */
function grantRule(plugins: PluginRegistry, kind: 'read' | 'write' | 'call-worker'): Rule {
  const permission = kind === 'call-worker' ? 'threads:call-worker' : `threads:${kind}-storage`;
  const what = kind === 'call-worker' ? 'call its worker' : `${kind} its storage`;
  return (req) => {
    const facts = plugins.facts(req.params.id);
    // A disabled or broken plugin granted nothing: its documents stay closed to every thread.
    if (!facts) return { ok: false, status: 404, error: 'out_of_scope', message: 'unknown plugin' };
    return facts.permissions.includes(permission)
      ? OK
      : { ok: false, status: 403, error: 'out_of_scope', message: `The plugin "${req.params.id}" does not let threads ${what}.` };
  };
}

/** Who is calling, for the worker: the owner, a thread, or a plugin (never the credential itself). */
function principalHeaders(req: Request): Record<string, string> {
  let p;
  try { p = principalOf(req); } catch { return { 'x-dispatch-principal': 'owner' }; }
  if (p.kind === 'thread') {
    const c = scopeOf(req).caller(p.terminalId);
    return { 'x-dispatch-principal': `thread:${p.terminalId}`, ...(c?.sessionId ? { 'x-dispatch-session': c.sessionId } : {}) };
  }
  if (p.kind === 'plugin') return { 'x-dispatch-principal': `plugin:${p.pluginId}` };
  return { 'x-dispatch-principal': 'owner' };
}

/** Headers that never cross to the worker: the caller's credentials and the hop-by-hop set. */
const DROPPED_HEADERS = new Set(['authorization', 'cookie', 'host', 'connection', 'keep-alive', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length', 'x-dispatch-principal', 'x-dispatch-session']);

/** The writer stamped on a document a thread key writes: from the key, never from the body. */
function writerOf(req: Request): pluginData.Writer | null {
  let p;
  try { p = principalOf(req); } catch { return null; }
  if (p.kind !== 'thread') return null;
  const c = scopeOf(req).caller(p.terminalId);
  return { terminalId: p.terminalId, sessionId: c?.sessionId ?? '', label: c?.label ?? null };
}

function storageError(res: import('express').Response, e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg === 'too large') return void res.status(413).json({ error: 'too_large', message: `A document is at most ${pluginData.DOC_MAX_BYTES} bytes.` });
  if (msg === 'too many') return void res.status(409).json({ error: 'too_many', message: `A plugin holds at most ${pluginData.DOCS_MAX} documents.` });
  if (msg === 'bad key') return void res.status(400).json({ error: 'bad_key', message: 'A key is letters, digits, dots, dashes, underscores and colons, up to 128.' });
  res.status(500).json({ error: msg });
}

export function createPluginsRouter(plugins: PluginRegistry, db: Database.Database, assist: AssistRunner | null = null): Router {
  const router = policyRouter();

  // The list is for the owner and for any thread key (a thread may ask what plugins exist).
  router.get('/plugins', keyRoute({ thread: projectListRule, roleRun: projectListRule, plugin: allowRule }), (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ plugins: plugins.list() });
  });

  router.post('/plugins/scaffold', ownerOnlyStrict, (req, res) => {
    const { id, name } = (req.body ?? {}) as { id?: unknown; name?: unknown };
    if (typeof id !== 'string' || typeof name !== 'string' || !name.trim()) return void res.status(400).json({ error: 'id and name are required' });
    try { res.status(201).json(plugins.scaffold(id, name.trim())); } catch (e) { fail(res, e); }
  });

  router.post('/plugins/:id/enable', ownerOnlyStrict, (req, res) => {
    try { const row = plugins.setEnabled(req.params.id, true); plugins.announce(row.id); res.json(row); } catch (e) { fail(res, e); }
  });

  router.post('/plugins/:id/disable', ownerOnlyStrict, (req, res) => {
    try { const row = plugins.setEnabled(req.params.id, false); plugins.announce(row.id); res.json(row); } catch (e) { fail(res, e); }
  });

  router.post('/plugins/:id/reload', ownerOnlyStrict, (req, res) => {
    const row = plugins.get(req.params.id);
    if (!row) return void res.status(404).json({ error: 'unknown plugin' });
    plugins.announce(row.id);
    res.json(row);
  });

  // Copy a bundled (or local) plugin to a new local id: the way to change a bundled one (spec section 10).
  router.post('/plugins/:id/copy', ownerOnlyStrict, (req, res) => {
    const { id } = (req.body ?? {}) as { id?: unknown };
    if (typeof id !== 'string') return void res.status(400).json({ error: 'bad id' });
    try { const row = plugins.copyToLocal(req.params.id, id); plugins.announce(row.id); res.status(201).json(row); } catch (e) { fail(res, e); }
  });

  router.delete('/plugins/:id', ownerOnlyStrict, (req, res) => {
    // ?keepData=1 keeps the plugin's documents, settings and files, so a reinstall finds them (owner, 2026-11-07).
    try { plugins.remove(req.params.id); if (req.query.keepData !== '1') pluginData.clearPlugin(db, req.params.id); plugins.announce(req.params.id); res.status(204).end(); } catch (e) { fail(res, e); }
  });

  // ── storage and settings (spec section 5) ──────────────────────────────────────────────
  const known = (req: Request, res: import('express').Response): boolean => {
    if (plugins.get(req.params.id)) return true;
    res.status(404).json({ error: 'unknown plugin' });
    return false;
  };
  const dataRead = keyRoute({ plugin: ownPluginRule, thread: grantRule(plugins, 'read'), roleRun: grantRule(plugins, 'read') });
  const dataWrite = keyRoute({ plugin: ownPluginRule, thread: grantRule(plugins, 'write'), roleRun: grantRule(plugins, 'write') });
  const settingsRule = keyRoute({ plugin: ownPluginRule });

  router.get('/plugins/:id/data', dataRead, (req, res) => {
    if (!known(req, res)) return;
    res.setHeader('Cache-Control', 'no-store');
    res.json({ docs: req.query.values === '1' ? pluginData.listDocs(db, req.params.id, { values: true }) : pluginData.listDocs(db, req.params.id) });
  });

  router.get('/plugins/:id/data/:key', dataRead, (req, res) => {
    if (!known(req, res)) return;
    const doc = pluginData.getDoc(db, req.params.id, req.params.key);
    if (!doc) return void res.status(404).json({ error: 'document not found' });
    res.setHeader('Cache-Control', 'no-store');
    res.json(doc);
  });

  // The body is `{ value }`: any JSON value, including a string or a number.
  router.put('/plugins/:id/data/:key', dataWrite, (req, res) => {
    if (!known(req, res)) return;
    const body = req.body as { value?: unknown } | undefined;
    if (!body || typeof body !== 'object' || !('value' in body)) return void res.status(400).json({ error: 'bad_body', message: 'Send { "value": ... }.' });
    try {
      const doc = pluginData.setDoc(db, req.params.id, req.params.key, body.value, writerOf(req));
      plugins.broadcast({ type: 'plugin:data', id: req.params.id, key: req.params.key });
      res.json(doc);
    } catch (e) { storageError(res, e); }
  });

  router.delete('/plugins/:id/data/:key', dataWrite, (req, res) => {
    if (!known(req, res)) return;
    if (!pluginData.deleteDoc(db, req.params.id, req.params.key)) return void res.status(404).json({ error: 'document not found' });
    plugins.broadcast({ type: 'plugin:data', id: req.params.id, key: req.params.key, deleted: true });
    res.status(204).end();
  });

  router.get('/plugins/:id/settings', settingsRule, (req, res) => {
    if (!known(req, res)) return;
    res.setHeader('Cache-Control', 'no-store');
    res.json(pluginData.getSettings(db, req.params.id) ?? { value: null, updatedAt: null });
  });

  router.put('/plugins/:id/settings', settingsRule, (req, res) => {
    if (!known(req, res)) return;
    const body = req.body as { value?: unknown } | undefined;
    if (!body || typeof body !== 'object' || !('value' in body)) return void res.status(400).json({ error: 'bad_body', message: 'Send { "value": ... }.' });
    try {
      const out = pluginData.setSettings(db, req.params.id, body.value);
      plugins.broadcast({ type: 'plugin:settings', id: req.params.id });
      res.json(out);
    } catch (e) { storageError(res, e); }
  });

  // ── file references (spec section 5): a checked file of a project, served to the owner ──
  // A thread registers a file of its own project (the plugin must grant threads:write-storage);
  // the owner or the plugin's own key names the project in the body.
  router.post('/plugins/:id/files', dataWrite, (req, res) => {
    if (!known(req, res)) return;
    const body = (req.body ?? {}) as { path?: unknown; sessionId?: unknown };
    let principal: ReturnType<typeof principalOf> | null = null;
    try { principal = principalOf(req); } catch { principal = null; }
    let sessionId: string | null = null;
    if (principal?.kind === 'thread') {
      sessionId = scopeOf(req).caller(principal.terminalId)?.sessionId ?? null;
      if (!sessionId) return void res.status(400).json({ error: 'bad_body', message: 'The thread has no project.' });
    } else {
      if (typeof body.sessionId !== 'string' || !body.sessionId) return void res.status(400).json({ error: 'bad_body', message: 'Send { path, sessionId }.' });
      sessionId = body.sessionId;
    }
    const session = sessionsDb.getById(db, sessionId);
    if (!session) return void res.status(404).json({ error: 'session not found' });
    try {
      const file = checkProjectFile(session.working_dir, body.path);
      res.status(201).json(pluginData.addFile(db, req.params.id, session.id, file));
    } catch (e) {
      if (e instanceof ProjectFileError) return void res.status(e.status).json({ error: e.message });
      throw e;
    }
  });

  // The bytes, for the owner only. Re-checked against the project's CURRENT folder: a project moved
  // since the post, or a file replaced by a symlink, must not turn this into a read outside it.
  router.get('/plugins/:id/files/:fileId', (req, res) => {
    if (!known(req, res)) return;
    const file = pluginData.getFile(db, req.params.id, req.params.fileId);
    const session = file ? sessionsDb.getById(db, file.sessionId) : null;
    if (!file || !session || !insideRealRoot(session.working_dir, file.path) || !fs.existsSync(file.path)) {
      return void res.status(404).json({ error: 'file not found' });
    }
    const mime = PROJECT_FILE_MIME[path.extname(file.path).toLowerCase()] ?? 'application/octet-stream';
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.setHeader('Content-Disposition', `inline; filename="${file.name.replace(/[^A-Za-z0-9._-]+/g, '_')}"`);
    // HTML runs scripts in an opaque origin; SVG and other markup get the plain sandbox (no scripts at all).
    setFileHeaders(res, mime, mime === 'text/html' ? HTML_SANDBOX_CSP : 'sandbox');
    res.type(mime);
    res.sendFile(file.path);
  });

  router.delete('/plugins/:id/files/:fileId', settingsRule, (req, res) => {
    if (!known(req, res)) return;
    if (!pluginData.removeFile(db, req.params.id, req.params.fileId)) return void res.status(404).json({ error: 'file not found' });
    res.status(204).end();
  });

  // ── marketplaces and installs (spec section 7): owner-only ───────────────────────────────
  const skillsOf = (req: Request): SkillsService | null => (req.app.locals.skills as SkillsService | undefined) ?? null;
  const marketsOf = (req: Request): MarketplaceService | null => (req.app.locals.marketplaces as MarketplaceService | undefined) ?? null;
  const installerOf = (req: Request): PluginInstaller | null => (req.app.locals.installer as PluginInstaller | undefined) ?? null;
  const installError = (res: import('express').Response, e: unknown): void => {
    const msg = e instanceof Error ? e.message : String(e);
    const status = /unknown marketplace|not in the marketplace|no version|no longer in/.test(msg) ? 404
      : /already installed|bundled plugin|local plugin .* exists|nothing to roll back|marketplace of this plugin is gone/.test(msg) ? 409
      : /not an installed plugin|bad id|needs Dispatch|needs SDK|not a marketplace url/.test(msg) ? 400 : 500;
    res.status(status).json({ error: msg });
  };

  router.get('/plugins/marketplaces', ownerOnlyStrict, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ marketplaces: marketsOf(req)?.list() ?? [] });
  });
  router.post('/plugins/marketplaces', ownerOnlyStrict, async (req, res) => {
    const m = marketsOf(req);
    if (!m) return void res.status(503).json({ error: 'no_marketplaces' });
    const { url } = (req.body ?? {}) as { url?: unknown };
    if (typeof url !== 'string') return void res.status(400).json({ error: 'url is required' });
    try { res.status(201).json(await m.add(url.trim())); } catch (e) { installError(res, e); }
  });
  router.delete('/plugins/marketplaces/:slug', ownerOnlyStrict, (req, res) => {
    const m = marketsOf(req);
    if (!m) return void res.status(503).json({ error: 'no_marketplaces' });
    try { m.remove(req.params.slug); res.status(204).end(); } catch (e) { installError(res, e); }
  });
  router.post('/plugins/marketplaces/:slug/pull', ownerOnlyStrict, async (req, res) => {
    const m = marketsOf(req);
    if (!m) return void res.status(503).json({ error: 'no_marketplaces' });
    try { res.json(await m.pull(req.params.slug)); } catch (e) { installError(res, e); }
  });
  router.post('/plugins/marketplaces/:slug/trusted', ownerOnlyStrict, (req, res) => {
    const m = marketsOf(req);
    if (!m) return void res.status(503).json({ error: 'no_marketplaces' });
    try { res.json(m.setTrusted(req.params.slug, (req.body as { on?: unknown })?.on === true)); } catch (e) { installError(res, e); }
  });
  // The catalog, with what is installed beside each plugin.
  router.get('/plugins/catalog', ownerOnlyStrict, async (req, res) => {
    const m = marketsOf(req);
    if (!m) return void res.status(503).json({ error: 'no_marketplaces' });
    const skillRows = skillsOf(req)?.list() ?? [];
    const urlOf = (slug: string) => m.get(slug)?.url ?? null;
    // "Installed" names the copy that came from THIS marketplace; the same id from another one is not it.
    const entries = (await m.catalog()).map((e) => {
      const rec = e.kind === 'plugin' ? plugins.get(e.id)?.install ?? null : skillRows.find((s) => s.id === e.id)?.install ?? null;
      const installed = rec && rec.marketplace === urlOf(e.marketplace) ? rec : null;
      return { ...e, folder: undefined, ...(installed ? { installed: { version: installed.version } } : {}) };
    });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ entries });
  });
  router.get('/plugins/updates', ownerOnlyStrict, async (req, res) => {
    const i = installerOf(req);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ updates: i ? await i.updates() : [] });
  });
  router.post('/plugins/updates/check', ownerOnlyStrict, async (req, res) => {
    const i = installerOf(req);
    if (!i) return void res.status(503).json({ error: 'no_installer' });
    try { res.json(await i.checkNow()); } catch (e) { installError(res, e); }
  });
  router.post('/plugins/install', ownerOnlyStrict, async (req, res) => {
    const i = installerOf(req);
    if (!i) return void res.status(503).json({ error: 'no_installer' });
    const { marketplace, id, version } = (req.body ?? {}) as { marketplace?: unknown; id?: unknown; version?: unknown };
    if (typeof marketplace !== 'string' || typeof id !== 'string') return void res.status(400).json({ error: 'marketplace and id are required' });
    try { res.status(201).json(await i.install(marketplace, id, typeof version === 'string' ? version : undefined)); } catch (e) { installError(res, e); }
  });
  router.get('/plugins/:id/versions', ownerOnlyStrict, async (req, res) => {
    const m = marketsOf(req);
    const row = plugins.get(req.params.id);
    if (!row) return void res.status(404).json({ error: 'unknown plugin' });
    const market = row.install ? m?.list().find((x) => x.url === row.install!.marketplace) : null;
    res.json({ versions: market && m ? await m.versions(market.slug, req.params.id) : [] });
  });
  router.post('/plugins/:id/update', ownerOnlyStrict, async (req, res) => {
    if (!known(req, res)) return;
    const i = installerOf(req);
    if (!i) return void res.status(503).json({ error: 'no_installer' });
    try { res.json(await i.update(req.params.id)); } catch (e) { installError(res, e); }
  });
  router.post('/plugins/:id/rollback', ownerOnlyStrict, async (req, res) => {
    if (!known(req, res)) return;
    const i = installerOf(req);
    if (!i) return void res.status(503).json({ error: 'no_installer' });
    try { res.json(await i.rollback(req.params.id)); } catch (e) { installError(res, e); }
  });
  router.post('/plugins/:id/pin', ownerOnlyStrict, (req, res) => {
    if (!known(req, res)) return;
    const i = installerOf(req);
    if (!i) return void res.status(503).json({ error: 'no_installer' });
    const v = (req.body as { version?: unknown })?.version;
    i.pin(req.params.id, typeof v === 'string' && v ? v : null);
    res.json(plugins.get(req.params.id));
  });
  router.post('/plugins/:id/auto-update', ownerOnlyStrict, (req, res) => {
    if (!known(req, res)) return;
    const i = installerOf(req);
    if (!i) return void res.status(503).json({ error: 'no_installer' });
    i.setAutoUpdate(req.params.id, (req.body as { on?: unknown })?.on === true);
    res.json(plugins.get(req.params.id));
  });

  // ── skills (spec section 8): the list is readable by every key; the rest is the owner's ──
  const skillError = (res: import('express').Response, e: unknown): void => {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(/unknown skill|unknown marketplace|not in the marketplace/.test(msg) ? 404 : /already installed/.test(msg) ? 409 : 400).json({ error: msg });
  };
  router.get('/skills', keyRoute({ thread: projectListRule, roleRun: projectListRule, plugin: needs('read:projects') }), (req, res) => {
    let principal: ReturnType<typeof principalOf> | null = null;
    try { principal = principalOf(req); } catch { principal = null; }
    res.setHeader('Cache-Control', 'no-store');
    if (principal?.kind === 'thread') {
      // A thread sees the skills its own project gets (what is in its prompt), and no paths or marketplace URLs.
      const own = scopeOf(req).caller(principal.terminalId)?.sessionId;
      const rows = (skillsOf(req)?.list(own) ?? []).filter((s) => s.enabled && s.enabledHere !== false && !s.error);
      return void res.json({ skills: rows.map((s) => ({ id: s.id, name: s.name, version: s.version, description: s.description, harnesses: s.harnesses, enabled: true, enabledHere: true, text: s.text.length > 400 ? `${s.text.slice(0, 400)}…` : s.text })) });
    }
    const project = typeof req.query.project === 'string' ? req.query.project : undefined;
    // The text stays short in the list; the owner's page shows it on demand.
    res.json({ skills: (skillsOf(req)?.list(project) ?? []).map((s) => ({ ...s, text: s.text.length > 400 ? `${s.text.slice(0, 400)}…` : s.text })) });
  });
  router.post('/skills/install', ownerOnlyStrict, async (req, res) => {
    const sv = skillsOf(req);
    if (!sv) return void res.status(503).json({ error: 'no_skills' });
    const { marketplace, id } = (req.body ?? {}) as { marketplace?: unknown; id?: unknown };
    if (typeof marketplace !== 'string' || typeof id !== 'string') return void res.status(400).json({ error: 'marketplace and id are required' });
    try { res.status(201).json(await sv.install(marketplace, id)); } catch (e) { skillError(res, e); }
  });
  router.delete('/skills/:id', ownerOnlyStrict, (req, res) => {
    const sv = skillsOf(req);
    if (!sv) return void res.status(503).json({ error: 'no_skills' });
    try { sv.remove(req.params.id); res.status(204).end(); } catch (e) { skillError(res, e); }
  });
  for (const [action, on] of [['enable', true], ['disable', false]] as const) {
    router.post(`/skills/:id/${action}`, ownerOnlyStrict, (req, res) => {
      const sv = skillsOf(req);
      if (!sv) return void res.status(503).json({ error: 'no_skills' });
      if (!sv.list().some((s) => s.id === req.params.id)) return void res.status(404).json({ error: 'unknown skill' });
      const project = (req.body as { project?: unknown })?.project;
      sv.setEnabled(req.params.id, on, typeof project === 'string' && project ? project : undefined);
      res.json(sv.list(typeof project === 'string' ? project : undefined).find((s) => s.id === req.params.id));
    });
  }

  // ── the worker (spec section 4): logs, restart, and the socket proxy ──────────────────────
  const workersOf = (req: Request): PluginWorkers | null => (req.app.locals.pluginWorkers as PluginWorkers | undefined) ?? null;

  router.get('/plugins/:id/logs', (req, res) => {
    if (!known(req, res)) return;
    const lines = Math.max(1, Math.min(2000, Number(req.query.lines) || 200));
    res.setHeader('Cache-Control', 'no-store');
    res.type('text/plain').send(workersOf(req)?.logTail(req.params.id, lines) ?? '');
  });

  // Before the proxy's catch-all: the owner's Restart is the daemon's, not the worker's.
  router.post('/plugins/:id/worker/restart', ownerOnlyStrict, (req, res) => {
    if (!known(req, res)) return;
    const w = workersOf(req);
    if (!w) return void res.status(503).json({ error: 'no_supervisor' });
    w.restart(req.params.id);
    res.json(w.stats(req.params.id) ?? { state: 'stopped' });
  });

  // The proxy: the caller's principal in headers, never its credential; the worker answers as itself.
  const workerRule = keyRoute({ plugin: ownPluginRule, thread: grantRule(plugins, 'call-worker'), roleRun: grantRule(plugins, 'call-worker') });
  router.all(['/plugins/:id/worker', '/plugins/:id/worker/*'], workerRule, (req, res) => {
    if (!known(req, res)) return;
    const stats = workersOf(req)?.stats(req.params.id);
    if (!stats?.socket) return void res.status(502).json({ error: 'no_worker', message: 'The plugin has no worker listening.' });
    // The path as the caller encoded it (Express decodes params): sliced from the raw URL after /worker.
    const marker = `/plugins/${req.params.id}/worker`;
    const at = req.originalUrl.indexOf(marker);
    const tail = at >= 0 ? req.originalUrl.slice(at + marker.length) : '';
    const upstreamPath = tail === '' ? '/' : tail.startsWith('/') ? tail : `/${tail}`;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (!DROPPED_HEADERS.has(k.toLowerCase()) && typeof v === 'string') headers[k] = v;
    Object.assign(headers, principalHeaders(req));
    const hasJson = req.is('application/json') && req.body !== undefined && typeof req.body === 'object';
    const body = hasJson ? Buffer.from(JSON.stringify(req.body)) : null;
    if (body) { headers['content-type'] = 'application/json'; headers['content-length'] = String(body.length); }
    const up = http.request({ socketPath: stats.socket, path: upstreamPath, method: req.method, headers }, (r) => {
      res.status(r.statusCode ?? 502);
      for (const [k, v] of Object.entries(r.headers)) if (v !== undefined && !['connection', 'keep-alive', 'transfer-encoding'].includes(k)) res.setHeader(k, v as string | string[]);
      r.pipe(res);
      r.on('error', () => { if (!res.headersSent) res.status(502).json({ error: 'no_worker' }); else res.end(); });
    });
    up.setTimeout(60_000, () => up.destroy(new Error('timeout')));
    up.on('error', () => { if (!res.headersSent) res.status(502).json({ error: 'no_worker', message: 'The worker did not answer.' }); else res.end(); });
    res.on('close', () => { if (!res.writableFinished) up.destroy(); });
    if (body) up.end(body);
    else if (req.method === 'GET' || req.method === 'HEAD') up.end();
    else req.pipe(up);
  });

  // ── model assist (spec section 3.4): the plugin's own key with model:assist, or the owner ──
  const assistRule: Rule = (req, ctx) => { const own = ownPluginRule(req, ctx); return own.ok ? needs('model:assist')(req, ctx) : own; };
  // A bound per plugin: each call is a model process on the owner's account.
  const inflight = new Map<string, number>();
  router.post('/plugins/:id/assist', keyRoute({ plugin: assistRule }), async (req, res) => {
    if (!known(req, res)) return;
    const body = (req.body ?? {}) as { system?: unknown; messages?: unknown; maxTokens?: unknown };
    const messages = Array.isArray(body.messages) ? body.messages.filter((m): m is { role: 'user' | 'assistant'; content: string } => !!m && typeof m === 'object' && ((m as { role?: unknown }).role === 'user' || (m as { role?: unknown }).role === 'assistant') && typeof (m as { content?: unknown }).content === 'string') : [];
    if (messages.length === 0) return void res.status(400).json({ error: 'bad_body', message: 'Send { messages: [{ role: "user", content: "..." }], system?, maxTokens? }.' });
    const maxTokens = Math.max(1, Math.min(2000, typeof body.maxTokens === 'number' ? Math.floor(body.maxTokens) : 800));
    if (!assist || !(await assist.available().catch(() => false))) {
      return void res.status(503).json({ error: 'no_model', message: 'No model is signed in for assist. Sign in to Claude Code or set an OpenRouter key.' });
    }
    const busy = inflight.get(req.params.id) ?? 0;
    if (busy >= ASSIST_INFLIGHT_MAX) return void res.status(429).json({ error: 'busy', message: `At most ${ASSIST_INFLIGHT_MAX} assist calls run at once for a plugin.` });
    inflight.set(req.params.id, busy + 1);
    let result;
    try { result = await assist.run({ system: typeof body.system === 'string' ? body.system : undefined, messages, maxTokens }).catch(() => null); }
    finally { inflight.set(req.params.id, (inflight.get(req.params.id) ?? 1) - 1); }
    if (!result) return void res.status(502).json({ error: 'no_answer', message: 'The model gave no answer.' });
    pluginData.recordAssist(db, req.params.id, result.usage, result.ms);
    res.json(result);
  });

  return router;
}

/**
 * `GET /plugins/<id>/<path>`: a file of an enabled plugin, same-origin so the app's CSP lets the
 * client import it. Never cached (the author is editing it). HTML gets the previews' sandbox: a
 * plugin page in a frame runs with no cookie and no app origin.
 */
export function pluginAssetHandler(plugins: PluginRegistry): RequestHandler[] {
  return [publicRoute, (req, res) => {
    const id = String(req.params.id ?? '');
    let rest: string;
    try { rest = decodeURIComponent(String(req.params[0] ?? '')); } catch { return void res.status(404).json({ error: 'plugin file not found' }); }
    const abs = plugins.resolveFile(id, rest);
    if (!abs) return void res.status(404).json({ error: 'plugin file not found' });
    res.setHeader('Cache-Control', 'no-cache');
    const ext = path.extname(abs).toLowerCase();
    if (ext === '.html' || ext === '.htm') setFileHeaders(res, 'text/html', HTML_SANDBOX_CSP);
    else if (ext === '.svg') setFileHeaders(res, 'image/svg+xml', 'sandbox');
    res.sendFile(abs);
  }];
}
