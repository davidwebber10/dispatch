import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as terminalsDb from '../../src/db/terminals.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as pluginData from '../../src/db/plugin-data.js';
import { createApp } from '../../src/server.js';
import { configureRefusalLog } from '../../src/auth/route-policy.js';
import { PROJECT_FILE_MAX_BYTES } from '../../src/plugins/files.js';
import { KeysManager } from './keys-manager.js';

/**
 * Plugin file references (plugins slice 4, Task 1): a thread registers a file of its own project
 * with a plugin, and the owner opens it through the daemon with the previews' checks and headers.
 */
describe('plugin file routes (2026-11-07)', () => {
  let app: any;
  let db: Database.Database;
  let tmp: string;
  let proj: string;
  let outside: string;
  const plugin = (id: string, permissions: string[]) => {
    const dir = path.join(tmp, 'plugins', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ id, name: id, version: '1.0.0', permissions }));
  };
  const asPlugin = (id: string) => ({ Authorization: `Bearer ${fs.readFileSync(path.join(tmp, 'keys', `plugin-${id}`), 'utf8').trim()}` });
  const asThread = (terminalId = 'tA') => ({ Authorization: `Bearer ${app.locals.keys.mint({ kind: 'thread', terminalId }).key}` });
  const register = (auth: Record<string, string>, id: string, body: Record<string, unknown>) =>
    request(app).post(`/api/plugins/${id}/files`).set(auth).set('Content-Type', 'application/json').send(JSON.stringify(body));

  beforeEach(() => {
    configureRefusalLog({ log: () => {} });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-files-'));
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-files-proj-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-files-out-'));
    fs.writeFileSync(path.join(proj, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    fs.writeFileSync(path.join(proj, 'page.html'), '<script>1</script>');
    fs.writeFileSync(path.join(proj, 'notes.md'), '# hi');
    fs.writeFileSync(path.join(proj, 'model.bin'), 'x');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret');
    db = new Database(':memory:');
    initSchema(db);
    plugin('previews', ['threads:read-storage', 'threads:write-storage']);
    plugin('closed', []);
    const mgr = new KeysManager();
    app = createApp({ db, skipPty: true, pluginsDir: path.join(tmp, 'plugins'), secretsDir: tmp, managers: new Map([['claude-code', mgr.asManager()]]) });
    sessionsDb.create(db, { id: 'A', provider: 'claude-code', name: 'Alpha', workingDir: proj });
    sessionsDb.create(db, { id: 'B', provider: 'claude-code', name: 'Beta', workingDir: outside });
    terminalsDb.create(db, { id: 'tA', sessionId: 'A', type: 'claude-code', label: 'Worker A', config: { transport: 'structured', role: 'agent' } });
    terminalsDb.create(db, { id: 'tB', sessionId: 'B', type: 'claude-code', label: 'Worker B', config: { transport: 'structured', role: 'agent' } });
  });
  afterEach(() => { for (const d of [tmp, proj, outside]) fs.rmSync(d, { recursive: true, force: true }); });

  // 2026-11-09: lists ask for a small copy; 185 full-size images closed the Previews page on an iPhone.
  it.runIf(process.platform === 'darwin' && fs.existsSync('/usr/bin/sips'))('?thumb=480 answers a small JPEG of an image; the plain URL still answers the original', async () => {
    const { execFileSync } = await import('node:child_process');
    fs.writeFileSync(path.join(proj, 'tiny.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
    execFileSync('/usr/bin/sips', ['-z', '1200', '2000', path.join(proj, 'tiny.png'), '--out', path.join(proj, 'big.png')], { stdio: 'ignore' });
    const reg = await register(asThread(), 'previews', { path: 'big.png' });
    const full = await request(app).get(`/api/plugins/previews/files/${reg.body.fileId}`).buffer(true);
    const thumb = await request(app).get(`/api/plugins/previews/files/${reg.body.fileId}?thumb=480`).buffer(true);
    expect(full.headers['content-type']).toMatch(/^image\/png/);
    expect(thumb.status).toBe(200);
    expect(thumb.headers['content-type']).toMatch(/^image\/jpeg/);
    expect(Number(thumb.headers['content-length'])).toBeLessThan(Number(full.headers['content-length']));
    expect(thumb.headers['x-content-type-options']).toBe('nosniff');
  });

  it('?thumb on a file that cannot be made small (not an image, a bad width, a broken image) answers the original', async () => {
    const md = await register(asThread(), 'previews', { path: 'notes.md' });
    const a = await request(app).get(`/api/plugins/previews/files/${md.body.fileId}?thumb=480`);
    expect(a.status).toBe(200);
    expect(a.headers['content-type']).toMatch(/^text\/markdown/);
    const png = await register(asThread(), 'previews', { path: 'shot.png' }); // 4 bytes: not a real image
    for (const q of ['?thumb=480', '?thumb=999', '?thumb=abc']) {
      const r = await request(app).get(`/api/plugins/previews/files/${png.body.fileId}${q}`);
      expect(r.status, q).toBe(200);
      expect(r.headers['content-type'], q).toMatch(/^image\/png/);
    }
  });

  it('a thread registers a file of its project and the owner opens it with the right type and sandbox header', async () => {
    const png = await register(asThread(), 'previews', { path: 'shot.png' });
    expect(png.status).toBe(201);
    expect(png.body).toMatchObject({ name: 'shot.png', mime: 'image/png', size: 4, sessionId: 'A' });
    expect(typeof png.body.fileId).toBe('string');
    const got = await request(app).get(`/api/plugins/previews/files/${png.body.fileId}`);
    expect(got.status).toBe(200);
    expect(got.headers['content-type']).toMatch(/^image\/png/);
    expect(got.headers['x-content-type-options']).toBe('nosniff');
    // W3-A: the test build has the security headers of the daemon, so an image carries the policy of the app.
    // It is not the sandbox policy: that one is for a file that can run script (below).
    expect(got.headers['content-security-policy']).not.toContain('sandbox');
    expect(got.headers['content-disposition']).toBe('inline; filename="shot.png"');

    const html = await register(asThread(), 'previews', { path: path.join(proj, 'page.html') });
    expect(html.status).toBe(201);
    const page = await request(app).get(`/api/plugins/previews/files/${html.body.fileId}`);
    expect(page.headers['content-type']).toMatch(/^text\/html/);
    expect(page.headers['content-security-policy']).toBe('sandbox allow-scripts allow-popups allow-forms allow-modals');
    expect(page.text).toBe('<script>1</script>');

    // The owner names the project; a plugin key names it too, for its own plugin only.
    const own = await register({}, 'previews', { path: 'notes.md', sessionId: 'A' });
    expect(own.status).toBe(201);
    expect(own.body.mime).toBe('text/markdown');
    expect((await register(asPlugin('previews'), 'previews', { path: 'notes.md', sessionId: 'A' })).status).toBe(201);
    expect((await register(asPlugin('closed'), 'previews', { path: 'notes.md', sessionId: 'A' })).status).toBe(403);
    expect((await register({}, 'previews', { path: 'notes.md' })).status).toBe(400);
    expect((await register({}, 'previews', { path: 'notes.md', sessionId: 'nope' })).status).toBe(404);
    expect((await register({}, 'nope', { path: 'notes.md', sessionId: 'A' })).status).toBe(404);
  });

  it('a path in the real form of the project folder (through a symlinked parent) is inside the project', async () => {
    const r = await register(asThread(), 'previews', { path: path.join(fs.realpathSync(proj), 'shot.png') });
    expect(r.status).toBe(201);
    expect((await request(app).get(`/api/plugins/previews/files/${r.body.fileId}`)).status).toBe(200);
  });

  it('a path outside the project, an unknown type, a missing file and an oversize file are refused with the previews messages', async () => {
    const out = await register(asThread(), 'previews', { path: path.join(outside, 'secret.txt') });
    expect(out.status).toBe(400);
    expect(out.body.error).toMatch(/outside the project folder/);
    expect((await register(asThread(), 'previews', { path: '../' + path.basename(outside) + '/secret.txt' })).status).toBe(400);
    const bin = await register(asThread(), 'previews', { path: 'model.bin' });
    expect(bin.status).toBe(400);
    expect(bin.body.error).toMatch(/unsupported file type: model.bin/);
    const missing = await register(asThread(), 'previews', { path: 'gone.png' });
    expect(missing.status).toBe(404);
    expect(missing.body.error).toMatch(/file not found/);
    fs.writeFileSync(path.join(proj, 'big.png'), '');
    fs.truncateSync(path.join(proj, 'big.png'), PROJECT_FILE_MAX_BYTES + 1);
    const big = await register(asThread(), 'previews', { path: 'big.png' });
    expect(big.status).toBe(400);
    expect(big.body.error).toMatch(/file too large \(max 50 MB\)/);
    expect((await register(asThread(), 'previews', { path: '' })).status).toBe(400);
    expect((await register(asThread(), 'previews', {})).status).toBe(400);
  });

  it('a file reference is served to the owner only; a thread key gets 403, and a plugin without the write grant takes no files', async () => {
    const r = await register(asThread(), 'previews', { path: 'shot.png' });
    expect((await request(app).get(`/api/plugins/previews/files/${r.body.fileId}`).set(asThread())).status).toBe(403);
    expect((await request(app).get(`/api/plugins/previews/files/${r.body.fileId}`).set(asThread('tB'))).status).toBe(403);
    expect((await request(app).get(`/api/plugins/previews/files/${r.body.fileId}`).set(asPlugin('previews'))).status).toBe(403);
    expect((await request(app).get('/api/plugins/previews/files/nope')).status).toBe(404);
    expect((await register(asThread(), 'closed', { path: 'shot.png' })).status).toBe(403);
    // A thread of project B registers into B only: the sessionId in its body is ignored.
    const b = await register(asThread('tB'), 'previews', { path: 'secret.txt', sessionId: 'A' });
    expect(b.status).toBe(201);
    expect(b.body.sessionId).toBe('B');
    expect((await register(asThread('tB'), 'previews', { path: 'shot.png', sessionId: 'A' })).status).toBe(404);
  });

  it('serve re-checks the real root: a file swapped for a link out of the project, or a project folder moved, 404s', async () => {
    const r = await register(asThread(), 'previews', { path: 'shot.png' });
    fs.rmSync(path.join(proj, 'shot.png'));
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(proj, 'shot.png'));
    const swapped = await request(app).get(`/api/plugins/previews/files/${r.body.fileId}`);
    expect(swapped.status).toBe(404);
    expect(swapped.text).not.toContain('top secret');
    fs.rmSync(path.join(proj, 'shot.png'));
    fs.writeFileSync(path.join(proj, 'shot.png'), 'back');
    expect((await request(app).get(`/api/plugins/previews/files/${r.body.fileId}`)).status).toBe(200);
    db.prepare('UPDATE sessions SET working_dir = ? WHERE id = ?').run(outside, 'A');
    expect((await request(app).get(`/api/plugins/previews/files/${r.body.fileId}`)).status).toBe(404);
  });

  it('a file reference is removed by the owner or the plugin key, and removing the plugin clears its files', async () => {
    const r = await register(asThread(), 'previews', { path: 'shot.png' });
    const r2 = await register(asThread(), 'previews', { path: 'notes.md' });
    expect((await request(app).delete(`/api/plugins/previews/files/${r.body.fileId}`).set(asThread())).status).toBe(403);
    expect((await request(app).delete(`/api/plugins/previews/files/${r.body.fileId}`).set(asPlugin('closed'))).status).toBe(403);
    expect((await request(app).delete(`/api/plugins/previews/files/${r.body.fileId}`).set(asPlugin('previews'))).status).toBe(204);
    expect((await request(app).delete(`/api/plugins/previews/files/${r.body.fileId}`)).status).toBe(404);
    expect(pluginData.getFile(db, 'previews', r2.body.fileId)).not.toBeNull();
    pluginData.clearPlugin(db, 'previews');
    expect(pluginData.getFile(db, 'previews', r2.body.fileId)).toBeNull();
  });
});
