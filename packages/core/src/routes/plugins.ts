import path from 'node:path';
import type Database from 'better-sqlite3';
import type { Router, RequestHandler, Request } from 'express';
import { policyRouter, publicRoute, ownerOnlyStrict, keyRoute, needs, type Rule } from '../auth/route-policy.js';
import { principalOf, scopeOf } from '../auth/request-principal.js';
import * as pluginData from '../db/plugin-data.js';
import { projectListRule, allowRule } from '../auth/key-rules.js';
import { setFileHeaders } from '../http/active-content.js';
import { HTML_SANDBOX_CSP } from './previews.js';
import type { PluginRegistry } from '../plugins/registry.js';
import type { AssistRunner } from '../assist/run.js';

/**
 * Plugins (docs/superpowers/specs/2026-11-07-plugins-design.md): the manifests, the owner's
 * actions on local plugins, and the plugin files the web client imports.
 */
function fail(res: import('express').Response, e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  const status = msg === 'unknown plugin' ? 404 : msg === 'exists' ? 409 : msg === 'bad id' || msg === 'not local' ? 400 : 500;
  res.status(status).json({ error: msg });
}

const OK = { ok: true } as const;

/** A plugin key reaches the storage and settings of its own plugin only. */
const ownPluginRule: Rule = (req, ctx) => (ctx.plugin?.id === req.params.id
  ? OK
  : { ok: false, status: 403, error: 'out_of_scope', message: 'A plugin reaches its own storage only.' });

/** A thread reaches a plugin's documents only when the plugin granted threads that access (spec section 5). */
function grantRule(plugins: PluginRegistry, kind: 'read' | 'write'): Rule {
  return (req) => {
    const facts = plugins.facts(req.params.id);
    // A disabled or broken plugin granted nothing: its documents stay closed to every thread.
    if (!facts) return { ok: false, status: 404, error: 'out_of_scope', message: 'unknown plugin' };
    return facts.permissions.includes(`threads:${kind}-storage`)
      ? OK
      : { ok: false, status: 403, error: 'out_of_scope', message: `The plugin "${req.params.id}" does not let threads ${kind} its storage.` };
  };
}

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

  router.delete('/plugins/:id', ownerOnlyStrict, (req, res) => {
    try { plugins.remove(req.params.id); pluginData.clearPlugin(db, req.params.id); plugins.announce(req.params.id); res.status(204).end(); } catch (e) { fail(res, e); }
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
    res.json({ docs: pluginData.listDocs(db, req.params.id) });
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

  // ── model assist (spec section 3.4): the plugin's own key with model:assist, or the owner ──
  const assistRule: Rule = (req, ctx) => { const own = ownPluginRule(req, ctx); return own.ok ? needs('model:assist')(req, ctx) : own; };
  router.post('/plugins/:id/assist', keyRoute({ plugin: assistRule }), async (req, res) => {
    if (!known(req, res)) return;
    const body = (req.body ?? {}) as { system?: unknown; messages?: unknown; maxTokens?: unknown };
    const messages = Array.isArray(body.messages) ? body.messages.filter((m): m is { role: 'user' | 'assistant'; content: string } => !!m && typeof m === 'object' && ((m as { role?: unknown }).role === 'user' || (m as { role?: unknown }).role === 'assistant') && typeof (m as { content?: unknown }).content === 'string') : [];
    if (messages.length === 0) return void res.status(400).json({ error: 'bad_body', message: 'Send { messages: [{ role: "user", content: "..." }], system?, maxTokens? }.' });
    const maxTokens = Math.max(1, Math.min(2000, typeof body.maxTokens === 'number' ? Math.floor(body.maxTokens) : 800));
    if (!assist || !(await assist.available().catch(() => false))) {
      return void res.status(503).json({ error: 'no_model', message: 'No model is signed in for assist. Sign in to Claude Code or set an OpenRouter key.' });
    }
    const result = await assist.run({ system: typeof body.system === 'string' ? body.system : undefined, messages, maxTokens }).catch(() => null);
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
