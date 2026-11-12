// The Inbox for a headless view (src/routes/inbox.ts, docs/headless-api.md section 11). Drops are made
// by the REAL Inbox MCP server (packages/plugins/previews/mcp/server.mjs) under a thread's key against a
// full daemon build (tests/daemon/kit.ts), then read through /api/inbox as the owner.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import request from 'supertest';
import { closeKits, kit, type Kit } from '../daemon/kit.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import * as pluginData from '../../src/db/plugin-data.js';
import { BUSINESS_ROUTES } from '../../src/profile/business-routes.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const SERVER = path.join(REPO, 'packages/plugins/previews/mcp/server.mjs');
const DOCS = path.join(REPO, 'docs/headless-api.md');
const SECRET = 'tok-very-secret-123456';

let dir: string;
const children: ChildProcess[] = [];
beforeEach(() => {
  const root = path.join(os.homedir(), 'projects');
  fs.mkdirSync(root, { recursive: true });
  dir = fs.mkdtempSync(path.join(root, 'inbox-'));
  fs.writeFileSync(path.join(dir, 'sales.csv'), 'region,total\nNorth,120\nSouth,95\n');
  fs.writeFileSync(path.join(dir, 'chart.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  fs.writeFileSync(path.join(dir, 'page.html'), '<script>alert(1)</script>');
  fs.writeFileSync(path.join(dir, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
});
afterEach(() => { for (const c of children.splice(0)) c.kill('SIGKILL'); closeKits(); fs.rmSync(dir, { recursive: true, force: true }); });

const envWith = (extra: Record<string, string>): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  for (const k of ['DISPATCH_PROFILE', 'OS_BASE_URL', 'OS_BOX_TOKEN', 'DISPATCH_BOX_TOKEN', 'OS_PUBLIC_URL', 'DISPATCH_OWNER_EMAIL']) delete env[k];
  return { ...env, ...extra };
};

interface Box { k: Kit; port: number; key: string }
async function box(profile: 'business' | 'developer'): Promise<Box> {
  const k = kit({ env: envWith(profile === 'business' ? { DISPATCH_PROFILE: 'business' } : {}), bundledDir: path.join(REPO, 'packages/plugins') });
  await k.server();
  sessionsDb.create(k.db, { id: 'P1', provider: 'claude-code', name: 'Reports', workingDir: dir });
  terminalsDb.create(k.db, { id: 'T1', sessionId: 'P1', type: 'claude-code', label: 'Sales by region', config: { transport: 'structured' } });
  const key = k.daemon.app.locals.keys.mint({ kind: 'thread', terminalId: 'T1' }).key as string;
  return { k, port: await k.port(), key };
}

/** The real Inbox MCP server, as a harness starts it: stdio, in the thread's folder, with the thread's key. */
function inboxServer(b: Box, env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [SERVER], { cwd: dir, env: { PATH: process.env.PATH ?? '', DISPATCH_AUTH: b.key, DISPATCH_API: `http://127.0.0.1:${b.port}`, DISPATCH_PLUGIN: 'previews', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  const pending = new Map<number, (v: any) => void>();
  let next = 1;
  readline.createInterface({ input: child.stdout! }).on('line', (l) => { try { const m = JSON.parse(l); pending.get(m.id)?.(m); pending.delete(m.id); } catch { /* */ } });
  const rpc = (method: string, params?: unknown): Promise<any> => new Promise((r) => { const id = next++; pending.set(id, r); child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const drop = async (args: Record<string, unknown>): Promise<string> => {
    const r = await rpc('tools/call', { name: 'preview', arguments: args });
    const parsed = JSON.parse(r.result.content[0].text);
    expect(parsed.ok).toBe(true);
    return parsed.id as string;
  };
  return { rpc, drop };
}

async function seed(b: Box) {
  const s = inboxServer(b);
  const table = await s.drop({ kind: 'table', paths: ['sales.csv'], title: 'Sales by region', note: 'This week, from the order system.' });
  const files = await s.drop({ kind: 'files', paths: ['chart.png', 'page.html', 'logo.svg'], title: 'Chart and page' });
  const secret = await s.drop({ kind: 'secret', text: SECRET, title: 'API token', note: 'For the import.' });
  const link = await s.drop({ kind: 'link', url: 'https://example.com/report', note: 'The shared report.' });
  return { table, files, secret, link };
}

const owner = async (b: Box) => request(await b.k.server());

describe('the Inbox routes (business profile)', () => {
  test('list: every field a view needs, newest first; a secret drop never carries its value; unread counts', async () => {
    const b = await box('business');
    const ids = await seed(b);
    const s = await owner(b);
    const r = await s.get('/api/inbox');
    expect(r.status).toBe(200);
    expect(r.body.unread).toBe(4);
    expect(r.body.hasMore).toBe(false);
    expect(r.body.drops.map((d: any) => d.id)).toEqual([ids.link, ids.secret, ids.files, ids.table]);
    const table = r.body.drops.find((d: any) => d.id === ids.table);
    expect(table).toEqual({
      id: ids.table, threadId: 'T1', threadTitle: 'Sales by region', projectId: 'P1', projectName: 'Reports',
      title: 'Sales by region', note: 'This week, from the order system.', kind: 'table', createdAt: expect.any(String),
      read: false, readAt: null, text: null,
      files: [{ id: expect.any(String), name: 'sales.csv', size: 32, type: 'text/csv', url: expect.stringMatching(new RegExp(`^/api/inbox/drops/${ids.table}/files/[0-9a-f-]{36}$`)) }],
    });
    const secret = r.body.drops.find((d: any) => d.id === ids.secret);
    expect(secret).toMatchObject({ kind: 'secret', text: null, secret: { present: true, expired: false }, title: 'API token' });
    expect(JSON.stringify(r.body)).not.toContain(SECRET);
    expect(r.body.drops.find((d: any) => d.id === ids.link)).toMatchObject({ kind: 'link', url: 'https://example.com/report', text: 'https://example.com/report' });
    // Filters and paging.
    expect((await s.get('/api/inbox?threadId=T1&limit=2')).body).toMatchObject({ hasMore: true, drops: [{ id: ids.link }, { id: ids.secret }] });
    expect((await s.get('/api/inbox?threadId=nope')).body.drops).toEqual([]);
    expect((await s.get('/api/inbox/unread')).body).toEqual({ total: 4, byThread: { T1: 4 }, byProject: { P1: 4 } });
    const one = await s.get(`/api/inbox/drops/${ids.secret}`);
    expect(one.status).toBe(200);
    expect(JSON.stringify(one.body)).not.toContain(SECRET);
    expect((await s.get('/api/inbox/drops/no-such-drop')).status).toBe(404);
  });

  test('mark read, mark all read, delete (the drop and its files go)', async () => {
    const b = await box('business');
    const ids = await seed(b);
    const s = await owner(b);
    const read = await s.post(`/api/inbox/drops/${ids.table}/read`);
    expect(read.status).toBe(200);
    expect(read.body.drop).toMatchObject({ id: ids.table, read: true, readAt: expect.any(String) });
    expect((await s.get('/api/inbox/unread')).body.total).toBe(3);
    expect((await s.get('/api/inbox?unread=1')).body.drops.map((d: any) => d.id)).not.toContain(ids.table);
    expect((await s.post('/api/inbox/read').send({ threadId: 'T1' })).body).toEqual({ marked: 3 });
    expect((await s.get('/api/inbox/unread')).body.total).toBe(0);
    const fileIds = (await s.get(`/api/inbox/drops/${ids.files}`)).body.drop.files.map((f: any) => f.id);
    expect((await s.delete(`/api/inbox/drops/${ids.files}`)).status).toBe(204);
    expect((await s.get(`/api/inbox/drops/${ids.files}`)).status).toBe(404);
    for (const id of fileIds) expect(pluginData.getFile(b.k.db, 'previews', id)).toBeNull();
    expect((await s.delete(`/api/inbox/drops/${ids.files}`)).status).toBe(404);
  });

  test('files: by id from the drop that lists it only; nosniff, attachment; HTML and SVG never as a page', async () => {
    const b = await box('business');
    const ids = await seed(b);
    const s = await owner(b);
    const tableFile = (await s.get(`/api/inbox/drops/${ids.table}`)).body.drop.files[0];
    const csv = await s.get(tableFile.url);
    expect(csv.status).toBe(200);
    expect(csv.text).toBe('region,total\nNorth,120\nSouth,95\n');
    expect(csv.headers['content-type']).toMatch(/^text\/csv/);
    expect(csv.headers['x-content-type-options']).toBe('nosniff');
    expect(csv.headers['content-disposition']).toBe(`attachment; filename="sales.csv"; filename*=UTF-8''sales.csv`);
    const [png, html, svg] = (await s.get(`/api/inbox/drops/${ids.files}`)).body.drop.files;
    expect((await s.get(png.url)).headers['content-type']).toBe('image/png');
    for (const f of [html, svg]) {
      const r = await s.get(f.url).buffer(true);
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toBe('application/octet-stream');
      expect(r.headers['content-disposition']).toMatch(/^attachment;/);
      expect(r.headers['content-security-policy']).toBe("sandbox; default-src 'none'");
    }
    // Another drop's file through this drop: refused. An unknown id: refused. No path is ever taken.
    expect((await s.get(`/api/inbox/drops/${ids.files}/files/${tableFile.id}`)).status).toBe(404);
    expect((await s.get(`/api/inbox/drops/${ids.files}/files/00000000-0000-4000-8000-000000000000`)).status).toBe(404);
    expect([400, 404]).toContain((await s.get(`/api/inbox/drops/${ids.files}/files/..%2F..%2Fetc%2Fpasswd`)).status);
  });

  test('a file with no snapshot is served from the project with the path policy: a file moved out of the folder is refused', async () => {
    const b = await box('business');
    const ids = await seed(b);
    const s = await owner(b);
    const f = (await s.get(`/api/inbox/drops/${ids.table}`)).body.drop.files[0];
    pluginData.setFileSnapshot(b.k.db, 'previews', f.id, null); // a row from before the snapshots
    expect((await s.get(f.url)).status).toBe(200);
    // The project file becomes a link to a file outside the project.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-out-'));
    fs.writeFileSync(path.join(outside, 'other.csv'), 'secret,1\n');
    fs.rmSync(path.join(dir, 'sales.csv'));
    fs.symlinkSync(path.join(outside, 'other.csv'), path.join(dir, 'sales.csv'));
    const r = await s.get(f.url);
    expect([403, 404]).toContain(r.status);
    expect(r.text).not.toContain('secret,1');
    fs.rmSync(outside, { recursive: true, force: true });
  });

  test('a secret: refused for business on the reveal route and redacted on the plugin data routes', async () => {
    const b = await box('business');
    const ids = await seed(b);
    const s = await owner(b);
    const r = await s.get(`/api/inbox/drops/${ids.secret}/secret`).set('Sec-Fetch-Site', 'same-origin').set('User-Agent', 'Mozilla/5.0');
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ code: 'not_available_in_profile', rule: 'inbox.secret' });
    const list = await s.get('/api/plugins/previews/data?values=1');
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(SECRET);
    expect(list.body.docs.find((d: any) => d.key === `preview:${ids.secret}`).value).toMatchObject({ kind: 'secret', text: null, redacted: true });
    const doc = await s.get(`/api/plugins/previews/data/preview:${ids.secret}`);
    expect(JSON.stringify(doc.body)).not.toContain(SECRET);
  });

  test('a thread key is refused on every Inbox route (an agent uses the plugin routes)', async () => {
    const b = await box('business');
    const ids = await seed(b);
    const s = await owner(b);
    const auth = { Authorization: `Bearer ${b.key}` };
    for (const r of [
      await s.get('/api/inbox').set(auth),
      await s.get('/api/inbox/unread').set(auth),
      await s.get(`/api/inbox/drops/${ids.table}`).set(auth),
      await s.post(`/api/inbox/drops/${ids.table}/read`).set(auth),
      await s.delete(`/api/inbox/drops/${ids.table}`).set(auth),
    ]) expect(r.status).toBe(403);
  });
});

describe('the Inbox routes (developer profile)', () => {
  test('the secret is given on an explicit request for that one drop; never in the list', async () => {
    const b = await box('developer');
    const ids = await seed(b);
    const s = await owner(b);
    expect(JSON.stringify((await s.get('/api/inbox')).body)).not.toContain(SECRET);
    const r = await s.get(`/api/inbox/drops/${ids.secret}/secret`).set('Sec-Fetch-Site', 'same-origin').set('User-Agent', 'Mozilla/5.0');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ value: SECRET });
    expect(r.headers['cache-control']).toBe('no-store');
    // Not a secret drop: 404. Past its 24 hours: 410, and the list says expired.
    expect((await s.get(`/api/inbox/drops/${ids.table}/secret`).set('Sec-Fetch-Site', 'same-origin').set('User-Agent', 'Mozilla/5.0')).status).toBe(404);
    const key = `preview:${ids.secret}`;
    const doc = pluginData.getDoc(b.k.db, 'previews', key)!;
    pluginData.setDoc(b.k.db, 'previews', key, { ...(doc.value as object), createdAt: new Date(Date.now() - 25 * 3_600_000).toISOString() }, doc.writer);
    expect((await s.get(`/api/inbox/drops/${ids.secret}/secret`).set('Sec-Fetch-Site', 'same-origin').set('User-Agent', 'Mozilla/5.0')).status).toBe(410);
    expect((await s.get(`/api/inbox/drops/${ids.secret}`)).body.drop.secret).toEqual({ present: false, expired: true });
    // The plugin's own data route is unchanged for a developer.
    expect(JSON.stringify((await s.get('/api/plugins/previews/data?values=1')).body)).toContain(SECRET);
  });
});

// INBOX_CAPTURE=<file>: write the real answers of one run (the examples in docs/headless-api.md section 11).
test.runIf(!!process.env.INBOX_CAPTURE)('capture the documented examples', async () => {
  const { WebSocket } = await import('ws');
  const b = await box('business');
  const frames: unknown[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${b.port}/api/events`);
  ws.on('message', (m) => { try { const f = JSON.parse(String(m)); if (String(f.type).startsWith('plugin:')) frames.push(f); } catch { /* */ } });
  await new Promise((r) => ws.once('open', r));
  const srv = inboxServer(b);
  const tools = (await srv.rpc('tools/list')).result.tools;
  const ids = await seed(b);
  const s = await owner(b);
  const out: Record<string, unknown> = { tools };
  out.list = (await s.get('/api/inbox?limit=2')).body;
  out.unread = (await s.get('/api/inbox/unread')).body;
  const table = (await s.get(`/api/inbox/drops/${ids.table}`)).body;
  out.drop = table;
  const csv = await s.get(table.drop.files[0].url);
  out.file = { status: csv.status, headers: Object.fromEntries(['content-type', 'content-disposition', 'x-content-type-options', 'content-security-policy', 'cache-control'].map((h) => [h, csv.headers[h]])), body: csv.text };
  out.read = (await s.post(`/api/inbox/drops/${ids.table}/read`)).body;
  out.readAll = (await s.post('/api/inbox/read').send({ threadId: 'T1' })).body;
  const del = await s.delete(`/api/inbox/drops/${ids.link}`);
  out.delete = del.status;
  const sec = await s.get(`/api/inbox/drops/${ids.secret}/secret`).set('Sec-Fetch-Site', 'same-origin').set('User-Agent', 'Mozilla/5.0');
  out.secretBusiness = { status: sec.status, body: sec.body };
  await new Promise((r) => setTimeout(r, 200));
  out.events = frames;
  ws.close();
  fs.writeFileSync(process.env.INBOX_CAPTURE!, JSON.stringify(out, null, 1));
});

describe('the Inbox names and the route table', () => {
  test('hosted: the tool and server read "Inbox"; the ids stay; a local install is unchanged', async () => {
    const b = await box('developer');
    const local = inboxServer(b);
    const li = await local.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    const lt = (await local.rpc('tools/list')).result.tools[0];
    expect(li.result.serverInfo).toEqual({ name: 'dispatch-previews', version: '1.0.0' });
    expect(lt.name).toBe('preview');
    expect(lt.title).toBeUndefined();
    expect(lt.annotations).toBeUndefined();
    const hosted = inboxServer(b, { DISPATCH_HOSTED: '1' });
    const hi = await hosted.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    const ht = (await hosted.rpc('tools/list')).result.tools[0];
    expect(hi.result.serverInfo).toEqual({ name: 'dispatch-previews', version: '1.0.0', title: 'Inbox' });
    expect(ht).toMatchObject({ name: 'preview', title: 'Put in Inbox', annotations: { title: 'Put in Inbox' } });
  });

  test('every Inbox route has a row: reading, read state and delete allowed for business; the secret refused; all documented', () => {
    const rows = Object.entries(BUSINESS_ROUTES).filter(([k]) => k.includes('/api/inbox'));
    expect(rows.map(([k]) => k).sort()).toEqual([
      'DELETE /api/inbox/drops/:dropId',
      'GET /api/inbox',
      'GET /api/inbox/drops/:dropId',
      'GET /api/inbox/drops/:dropId/files/:fileId',
      'GET /api/inbox/drops/:dropId/secret',
      'GET /api/inbox/unread',
      'POST /api/inbox/drops/:dropId/read',
      'POST /api/inbox/read',
    ]);
    for (const [k, row] of rows) expect(row.business).toBe(k.endsWith('/secret') ? 'refuse' : 'allow');
    const docs = fs.readFileSync(DOCS, 'utf8');
    for (const [k] of rows) expect(docs).toContain(`\`${k}\``);
  });
});
