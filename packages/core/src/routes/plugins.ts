import path from 'node:path';
import type { Router, RequestHandler } from 'express';
import { policyRouter, publicRoute, ownerOnlyStrict, keyRoute } from '../auth/route-policy.js';
import { projectListRule, allowRule } from '../auth/key-rules.js';
import { setFileHeaders } from '../http/active-content.js';
import { HTML_SANDBOX_CSP } from './previews.js';
import type { PluginRegistry } from '../plugins/registry.js';

/**
 * Plugins (docs/superpowers/specs/2026-11-07-plugins-design.md): the manifests, the owner's
 * actions on local plugins, and the plugin files the web client imports.
 */
function fail(res: import('express').Response, e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  const status = msg === 'unknown plugin' ? 404 : msg === 'exists' ? 409 : msg === 'bad id' || msg === 'not local' ? 400 : 500;
  res.status(status).json({ error: msg });
}

export function createPluginsRouter(plugins: PluginRegistry): Router {
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
    try { plugins.remove(req.params.id); plugins.announce(req.params.id); res.status(204).end(); } catch (e) { fail(res, e); }
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
