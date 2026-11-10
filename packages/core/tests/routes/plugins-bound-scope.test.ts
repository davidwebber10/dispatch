import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import { createApp } from '../../src/server.js';
import { configureRefusalLog } from '../../src/auth/route-policy.js';
import { parseManifest } from '../../src/plugins/manifest.js';
import { KeysManager } from './keys-manager.js';

/**
 * A plugin reaches its own id only (engineering program 2026-11-09, W3-F).
 *
 * Two callers act for a plugin. Its worker and its MCP server hold the plugin key: the key's scope
 * is the plugin's own routes. Its web bundle runs in the owner's browser, with the owner's session:
 * the narrow SDK names the plugin it is bound to in `X-Dispatch-Plugin-Bound`, and the daemon refuses
 * a request whose header names one plugin and whose path names another.
 */
describe('a plugin reaches its own id only (W3-F)', () => {
  let app: any;
  let db: Database.Database;
  let tmp: string;
  const lines: string[] = [];
  const plugin = (id: string) => {
    const dir = path.join(tmp, 'plugins', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ id, name: id, version: '1.0.0', permissions: ['model:assist', 'notify:push'] }));
  };
  const asPlugin = (id: string) => ({ Authorization: `Bearer ${fs.readFileSync(path.join(tmp, 'keys', `plugin-${id}`), 'utf8').trim()}` });
  const bound = (id: string) => ({ 'X-Dispatch-Plugin': id, 'X-Dispatch-Plugin-Bound': id });
  const json = (r: request.Test, body: unknown) => r.set('Content-Type', 'application/json').send(JSON.stringify(body));

  beforeEach(() => {
    lines.length = 0;
    configureRefusalLog({ log: (l) => { lines.push(l); } });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-bound-'));
    db = new Database(':memory:');
    initSchema(db);
    plugin('mine');
    plugin('theirs');
    const mgr = new KeysManager();
    app = createApp({ db, skipPty: true, pluginsDir: path.join(tmp, 'plugins'), secretsDir: tmp, managers: new Map([['claude-code', mgr.asManager()]]) });
  });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  describe('the web bundle (the owner\'s session, the bound header)', () => {
    it('a request bound to one plugin cannot read another plugin\'s storage', async () => {
      await json(request(app).put('/api/plugins/theirs/data/secret'), { value: 'theirs' }).expect(200);
      for (const url of ['/api/plugins/theirs/data/secret', '/api/plugins/theirs/data', '/api/plugins/theirs/data?values=1', '/api/plugins/theirs/settings']) {
        const r = await request(app).get(url).set(bound('mine'));
        expect(r.status, url).toBe(403);
        expect(r.body.error, url).toBe('out_of_scope');
        expect(JSON.stringify(r.body), url).not.toContain('theirs"');
      }
    });

    it('a request bound to one plugin cannot write or delete another plugin\'s storage or settings', async () => {
      await json(request(app).put('/api/plugins/theirs/data/k'), { value: 'theirs' }).expect(200);
      expect((await json(request(app).put('/api/plugins/theirs/data/k').set(bound('mine')), { value: 'stolen' })).status).toBe(403);
      expect((await request(app).delete('/api/plugins/theirs/data/k').set(bound('mine'))).status).toBe(403);
      expect((await json(request(app).put('/api/plugins/theirs/settings').set(bound('mine')), { value: { x: 1 } })).status).toBe(403);
      expect((await request(app).get('/api/plugins/theirs/data/k')).body.value).toBe('theirs');
      expect((await request(app).get('/api/plugins/theirs/settings')).body.value).toBeNull();
    });

    it('the same holds for the worker proxy, the model call, the budget, the files, and enable or disable', async () => {
      const calls: [string, string][] = [
        ['get', '/api/plugins/theirs/worker/jobs'], ['post', '/api/plugins/theirs/worker/jobs/run'],
        ['post', '/api/plugins/theirs/assist'], ['get', '/api/plugins/theirs/assist/usage'], ['get', '/api/plugins/theirs/assist/share'],
        ['get', '/api/plugins/theirs/budget'], ['put', '/api/plugins/theirs/budget'],
        ['delete', '/api/plugins/theirs/files/f1'], ['get', '/api/plugins/theirs/files/f1'], ['post', '/api/plugins/theirs/files'],
        ['post', '/api/plugins/theirs/disable'], ['post', '/api/plugins/theirs/enable'], ['post', '/api/plugins/theirs/notify'],
        ['get', '/api/plugins/theirs/export'], ['delete', '/api/plugins/theirs'],
      ];
      for (const [method, url] of calls) {
        const r = await (request(app) as unknown as Record<string, (u: string) => request.Test>)[method](url).set(bound('mine'));
        expect(r.status, `${method} ${url}`).toBe(403);
        expect(r.body.error, `${method} ${url}`).toBe('out_of_scope');
      }
      // Nothing was changed: the other plugin is still there and still enabled.
      const rows = (await request(app).get('/api/plugins')).body.plugins as { id: string; enabled: boolean }[];
      expect(rows.find((p) => p.id === 'theirs')?.enabled).toBe(true);
    });

    it('a path that climbs out of the plugin\'s own routes is refused as well', async () => {
      await json(request(app).put('/api/plugins/theirs/data/k'), { value: 'theirs' }).expect(200);
      // What a browser sends for `/api/plugins/mine/worker/../../theirs/data/k` after it resolves the dots.
      expect((await request(app).get('/api/plugins/theirs/data/k').set(bound('mine'))).status).toBe(403);
      // An encoded id is decoded before the comparison.
      expect((await request(app).get('/api/plugins/%74heirs/data/k').set(bound('mine'))).status).toBe(403);
    });

    it('a request bound to a plugin reaches that plugin\'s own routes as before', async () => {
      expect((await json(request(app).put('/api/plugins/mine/data/k').set(bound('mine')), { value: 1 })).status).toBe(200);
      expect((await request(app).get('/api/plugins/mine/data/k').set(bound('mine'))).body.value).toBe(1);
      expect((await request(app).get('/api/plugins/mine/data?values=1').set(bound('mine'))).body.docs).toHaveLength(1);
      expect((await json(request(app).put('/api/plugins/mine/settings').set(bound('mine')), { value: { a: 1 } })).status).toBe(200);
      expect((await request(app).get('/api/plugins/mine/settings').set(bound('mine'))).body.value).toEqual({ a: 1 });
      expect((await request(app).get('/api/plugins/mine/budget').set(bound('mine'))).status).toBe(200);
      expect((await request(app).delete('/api/plugins/mine/data/k').set(bound('mine'))).status).toBe(204);
    });

    it('routes that name no plugin are not affected by the header', async () => {
      expect((await request(app).get('/api/plugins').set(bound('mine'))).status).toBe(200);
      expect((await request(app).get('/api/skills').set(bound('mine'))).status).toBe(200);
      expect((await request(app).get('/api/plugins/marketplaces').set(bound('mine'))).status).toBe(200);
    });

    it('compatibility: X-Dispatch-Plugin alone (the version 1 SDK) is a log tag, as before', async () => {
      await json(request(app).put('/api/plugins/theirs/data/k'), { value: 'theirs' }).expect(200);
      expect((await request(app).get('/api/plugins/theirs/data/k').set({ 'X-Dispatch-Plugin': 'mine' })).status).toBe(200);
      expect((await request(app).get('/api/plugins/theirs/data/k')).status).toBe(200);
    });

    it('the refusal is logged with both ids', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await request(app).get('/api/plugins/theirs/data').set(bound('mine')).expect(403);
        await request(app).get('/api/plugins/theirs/data').set(bound('mine')).expect(403);
        const said = log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[plugins] refused'));
        expect(said).toHaveLength(1); // once for the pair, not once for each request
        expect(said[0]).toMatch(/plugin "mine".*"theirs"/);
      } finally { log.mockRestore(); }
    });
  });

  describe('the plugin key (the worker and the MCP server)', () => {
    it('a plugin key reaches no route of another plugin', async () => {
      await json(request(app).put('/api/plugins/theirs/data/k'), { value: 'theirs' }).expect(200);
      const calls: [string, string][] = [
        ['get', '/api/plugins/theirs/data'], ['get', '/api/plugins/theirs/data?values=1'], ['get', '/api/plugins/theirs/data/k'],
        ['put', '/api/plugins/theirs/data/k'], ['delete', '/api/plugins/theirs/data/k'],
        ['get', '/api/plugins/theirs/settings'], ['put', '/api/plugins/theirs/settings'],
        ['post', '/api/plugins/theirs/files'], ['delete', '/api/plugins/theirs/files/f1'], ['get', '/api/plugins/theirs/files/f1'],
        ['get', '/api/plugins/theirs/worker/jobs'], ['post', '/api/plugins/theirs/assist'],
        ['get', '/api/plugins/theirs/assist/usage'], ['get', '/api/plugins/theirs/assist/share'],
        ['get', '/api/plugins/theirs/budget'], ['put', '/api/plugins/theirs/budget'], ['post', '/api/plugins/theirs/notify'],
        ['post', '/api/plugins/theirs/disable'], ['get', '/api/plugins/theirs/export'], ['delete', '/api/plugins/theirs'],
      ];
      for (const [method, url] of calls) {
        const r = await json((request(app) as unknown as Record<string, (u: string) => request.Test>)[method](url).set(asPlugin('mine')), { value: 'stolen' });
        expect(r.status, `${method} ${url}`).toBe(403);
      }
      expect((await request(app).get('/api/plugins/theirs/data/k')).body.value).toBe('theirs');
    });

    it('a plugin key that also sends a bound header for another plugin is refused on its own routes', async () => {
      expect((await request(app).get('/api/plugins/mine/data').set(asPlugin('mine')).set(bound('theirs'))).status).toBe(403);
      expect((await request(app).get('/api/plugins/mine/data').set(asPlugin('mine')).set(bound('mine'))).status).toBe(200);
    });
  });

  describe('the manifest', () => {
    it('sdkVersion is read as the sdk field; sdk wins when both are there', () => {
      const parse = (extra: Record<string, unknown>) => {
        const r = parseManifest(JSON.stringify({ id: 'x', name: 'X', version: '1.0.0', ...extra }), 'x');
        return r.ok ? r.manifest.sdk : 'error';
      };
      expect(parse({})).toBeUndefined();
      expect(parse({ sdk: 1 })).toBe(1);
      expect(parse({ sdk: 2 })).toBe(2);
      expect(parse({ sdkVersion: 2 })).toBe(2);
      expect(parse({ sdk: 2, sdkVersion: 1 })).toBe(2);
      expect(parse({ sdkVersion: '2' })).toBeUndefined();
    });
  });
});
