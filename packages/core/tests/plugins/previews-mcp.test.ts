import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as terminalsDb from '../../src/db/terminals.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as pluginData from '../../src/db/plugin-data.js';
import { createApp } from '../../src/server.js';
import { configureRefusalLog } from '../../src/auth/route-policy.js';
import { KeysManager } from '../routes/keys-manager.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const SERVER = path.join(REPO, 'packages/plugins/previews/mcp/server.mjs');

/**
 * The bundled Previews plugin's MCP server (plugins slice 4): a standalone stdio JSON-RPC server
 * with one tool, run under a thread's key against a real daemon app.
 */
describe('the Previews plugin MCP server', () => {
  let app: any; let db: Database.Database; let tmp: string; let proj: string; let outside: string;
  let server: ReturnType<any['listen']>; let port: number; let child: ChildProcess | null; let rl: readline.Interface | null;
  const pending = new Map<number, (v: any) => void>();
  let nextId = 1;

  const rpc = (method: string, params?: unknown): Promise<any> => new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child!.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const start = (env: Record<string, string>) => {
    // The harness starts an MCP server in the thread's working directory: relative paths resolve there.
    child = spawn(process.execPath, [SERVER], { cwd: proj, env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    rl = readline.createInterface({ input: child.stdout! });
    rl.on('line', (line) => { try { const m = JSON.parse(line); const r = pending.get(m.id); if (r) { pending.delete(m.id); r(m); } } catch { /* not ours */ } });
    child.stderr!.on('data', () => { /* a message the test does not read */ });
  };
  const callPreview = async (args: unknown) => {
    const r = await rpc('tools/call', { name: 'preview', arguments: args });
    const text = r.result?.content?.[0]?.text ?? '';
    let parsed: any = null; try { parsed = JSON.parse(text); } catch { parsed = null; }
    return { raw: r, text, parsed, isError: r.result?.isError === true };
  };

  beforeEach(async () => {
    configureRefusalLog({ log: () => {} });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'previews-mcp-'));
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'previews-mcp-proj-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'previews-mcp-out-'));
    fs.writeFileSync(path.join(proj, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    fs.writeFileSync(path.join(proj, 'notes.md'), '# hi');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret');
    db = new Database(':memory:'); initSchema(db);
    const mgr = new KeysManager();
    app = createApp({ db, skipPty: true, pluginsDir: path.join(tmp, 'plugins'), bundledDir: path.join(REPO, 'packages/plugins'), secretsDir: tmp, managers: new Map([['claude-code', mgr.asManager()]]) });
    sessionsDb.create(db, { id: 'A', provider: 'claude-code', name: 'Alpha', workingDir: proj });
    terminalsDb.create(db, { id: 'tA', sessionId: 'A', type: 'claude-code', label: 'Worker A', config: { transport: 'structured', role: 'agent' } });
    await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()); });
    port = (server.address() as { port: number }).port;
    child = null; rl = null; pending.clear();
  });
  afterEach(async () => {
    rl?.close(); child?.kill('SIGKILL');
    await new Promise<void>((r) => server.close(() => r()));
    for (const d of [tmp, proj, outside]) fs.rmSync(d, { recursive: true, force: true });
  });

  it('lists the preview tool and posts a preview: the files registered, the document stored, the files served to the owner', async () => {
    const key = app.locals.keys.mint({ kind: 'thread', terminalId: 'tA' }).key as string;
    start({ DISPATCH_AUTH: key, DISPATCH_API: `http://127.0.0.1:${port}`, DISPATCH_PLUGIN: 'previews' });
    const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    expect(init.result.serverInfo.name).toBe('dispatch-previews');
    const list = await rpc('tools/list');
    expect(list.result.tools.map((t: any) => t.name)).toEqual(['preview']);
    const r = await callPreview({ paths: ['shot.png', path.join(proj, 'notes.md')], text: 'copy me', title: 'A shot', note: 'the login page' });
    expect(r.isError).toBe(false);
    expect(r.parsed).toMatchObject({ ok: true, files: ['shot.png', 'notes.md'] });
    const doc = pluginData.getDoc(db, 'previews', `preview:${r.parsed.id}`);
    expect(doc?.value).toMatchObject({ id: r.parsed.id, sessionId: 'A', sessionName: 'Alpha', terminalId: 'tA', terminalLabel: 'Worker A', title: 'A shot', note: 'the login page', text: 'copy me', seenAt: null });
    const files = (doc!.value as { files: { fileId: string; name: string; mime: string; size: number }[] }).files;
    expect(files.map((f) => [f.name, f.mime, f.size])).toEqual([['shot.png', 'image/png', 4], ['notes.md', 'text/markdown', 4]]);
    expect(doc?.writer).toMatchObject({ terminalId: 'tA', sessionId: 'A' });
    const served = await request(app).get(`/api/plugins/previews/files/${files[1].fileId}`);
    expect(served.status).toBe(200);
    expect(served.text).toBe('# hi');
    // Text alone is a preview too; nothing at all is not.
    expect((await callPreview({ text: 'just text' })).parsed).toMatchObject({ ok: true, files: [] });
    const none = await callPreview({});
    expect(none.isError).toBe(true);
    expect(none.text).toMatch(/needs text or at least one path/);
  });

  it('refuses a path outside the project with the plain message, and a disabled plugin answers a plain error', async () => {
    const key = app.locals.keys.mint({ kind: 'thread', terminalId: 'tA' }).key as string;
    start({ DISPATCH_AUTH: key, DISPATCH_API: `http://127.0.0.1:${port}`, DISPATCH_PLUGIN: 'previews' });
    const out = await callPreview({ paths: [path.join(outside, 'secret.txt')] });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/outside the project folder/);
    expect((await callPreview({ paths: ['gone.png'] })).text).toMatch(/file not found/);
    await request(app).post('/api/plugins/previews/disable').set('Origin', `http://127.0.0.1:${port}`).expect(200);
    const off = await callPreview({ text: 'hello' });
    expect(off.isError).toBe(true);
    expect(off.text).toMatch(/Previews plugin is disabled/);
    expect(pluginData.listDocs(db, 'previews')).toEqual([]);
  });
});
