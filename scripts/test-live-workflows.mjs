#!/usr/bin/env node
// Run against a disposable Dispatch install. Creates a project under the current
// user's home and keeps it for restart/recovery checks. No provider login needed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../packages/core/package.json', import.meta.url));
const WebSocket = require('ws');
const base = process.env.DISPATCH_TEST_URL ?? 'http://localhost:3456';
const results = [];
async function request(method, url, body, expected = 200) {
  const res = await fetch(base + url, {
    method, headers: body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {},
    body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  assert.equal(res.status, expected, `${method} ${url}: ${text}`);
  return text ? JSON.parse(text) : undefined;
}
async function check(name, fn) {
  try { await fn(); results.push({ name, status: 'pass' }); }
  catch (e) { results.push({ name, status: 'fail', error: String(e) }); }
}
const dir = fs.mkdtempSync(path.join(os.homedir(), 'dispatch-parity-'));
execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'ignore' });
fs.writeFileSync(path.join(dir, 'seed.txt'), 'initial\n');
execFileSync('git', ['-C', dir, 'add', '.']);
execFileSync('git', ['-C', dir, '-c', 'user.name=Dispatch Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'test fixture'], { stdio: 'ignore' });
let project, terminal;
await check('project create and directory with spaces', async () => {
  project = await request('POST', '/api/sessions', { name: 'WSL parity', workingDir: dir, provider: 'claude-code' }, 201);
  assert.ok(project.id);
  const spaced = await request('POST', '/api/sessions', { name: 'Spaces', workingDir: path.join(dir, 'space folder'), provider: 'claude-code' }, 201);
  assert.ok(fs.existsSync(path.join(dir, 'space folder')));
  await request('DELETE', `/api/sessions/${spaced.id}`, undefined, 204);
});
if (!project) throw new Error(JSON.stringify(results));
const root = `/api/sessions/${project.id}`;
await check('project rename, list and active-project persistence', async () => {
  await request('PATCH', root, { name: 'WSL parity verified' });
  assert.equal((await request('GET', root)).name, 'WSL parity verified');
  assert.ok((await request('GET', '/api/sessions')).some(x => x.id === project.id));
  await request('POST', '/api/state/active-session', { sessionId: project.id });
  assert.equal((await request('GET', '/api/state/active-session')).sessionId, project.id);
});
await check('file write/read/rename, Unicode and spaces', async () => {
  await request('POST', root + '/files/mkdir?path=docs');
  await request('PUT', root + '/files/write?path=docs%2Fhello%20world.txt', { content: 'Hello WSL — café\n' });
  assert.equal((await request('GET', root + '/files/read?path=docs%2Fhello%20world.txt')).content, 'Hello WSL — café\n');
  await request('POST', root + '/files/rename', { from: 'docs/hello world.txt', to: 'docs/renamed.txt' });
  assert.equal((await request('GET', root + '/files/read?path=docs/renamed.txt')).content, 'Hello WSL — café\n');
});
await check('file upload, inbox attachment and image bytes', async () => {
  const data = new FormData();
  data.append('file', new Blob(['upload content']), 'upload.txt');
  await request('POST', root + '/files/upload', data);
  assert.equal((await request('GET', root + '/files/read?path=upload.txt')).content, 'upload content');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jE0sAAAAASUVORK5CYII=', 'base64');
  const image = new FormData(); image.append('file', new Blob([png], { type: 'image/png' }), 'test image.png');
  const uploaded = await request('POST', root + '/files/inbox', image);
  assert.equal(uploaded.ok, true);
  const response = await fetch(base + root + '/files/image?path=' + encodeURIComponent(uploaded.path));
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
});
await check('Git branch and changed files', async () => {
  assert.equal((await request('GET', root + '/git')).branch, 'main');
  const status = await request('GET', root + '/git/status');
  assert.ok(status.files.some(x => x.path === 'upload.txt'));
});
await check('file listing/search and traversal rejection', async () => {
  await request('GET', root + '/files');
  await request('GET', root + '/files/flat');
  await request('PUT', root + '/files/write?path=..%2Fescape.txt', { content: 'refuse' }, 403);
});
await check('terminal create', async () => {
  terminal = await request('POST', root + '/terminals', { type: 'shell', label: 'Parity terminal' }, 201);
  assert.ok(terminal.id);
});
if (terminal) {
  await check('terminal WebSocket input, output, resize and managed Codex PATH', async () => {
    const socket = new WebSocket(base.replace(/^http/, 'ws') + `/api/terminals/${terminal.id}/ws?cols=100&rows=30&meta=1`);
    let output = '';
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('terminal output timed out: ' + output.slice(-1200))), 15_000);
        socket.on('error', reject);
        socket.on('message', b => {
          output += b.toString();
          if (output.includes('PARITY-actual-output') && /codex-cli [0-9]/.test(output)) { clearTimeout(timer); resolve(); }
        });
        socket.on('open', () => {
          socket.send(JSON.stringify({ type: 'resize', cols: 110, rows: 32 }));
          socket.send("printf 'PARITY-%s\\n' 'actual-output'; codex --version\r");
        });
      });
    } finally { socket.close(); }
  });
  await check('terminal scrollback, rename, pin and alerts', async () => {
    assert.ok((await request('GET', `/api/terminals/${terminal.id}/scrollback`)).totalBytes > 0);
    await request('PATCH', `/api/terminals/${terminal.id}`, { label: 'Verified terminal', pinned: true });
    assert.equal((await request('GET', `/api/terminals/${terminal.id}`)).label, 'Verified terminal');
    await request('PATCH', `/api/terminals/${terminal.id}/alerts`, { enabled: true });
  });
}
await check('queued agent creation without launching a model', async () => {
  const queued = await request('POST', root + '/terminals', { type: 'codex', label: 'Queued parity task', queued: true, task: 'Reply with hello when started.', config: { transport: 'structured' } }, 201);
  assert.equal(queued.status, 'queued');
});
await check('provider detection, host capabilities and update state', async () => {
  const providers = await request('GET', '/api/setup/providers?fresh=1');
  assert.ok(providers.find(x => x.name === 'codex')?.installed);
  await request('GET', '/api/state/host');
  await request('GET', '/api/state/update');
  await request('GET', '/api/setup/harnesses');
});
const report = { at: new Date().toISOString(), platform: process.platform, projectId: project.id, terminalId: terminal?.id, dir, results };
fs.writeFileSync(path.join(os.homedir(), 'dispatch-parity-results.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exitCode = results.some(r => r.status === 'fail') ? 1 : 0;
