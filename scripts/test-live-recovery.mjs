#!/usr/bin/env node
// Run after restarting/rebooting the disposable host used by test-live-workflows.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../packages/core/package.json', import.meta.url));
const WebSocket = require('ws');
const prior = JSON.parse(fs.readFileSync(path.join(os.homedir(), 'dispatch-parity-results.json'), 'utf8'));
const base = process.env.DISPATCH_TEST_URL ?? 'http://localhost:3456';
async function get(url) {
  const res = await fetch(base + url, { signal: AbortSignal.timeout(15000) });
  assert.equal(res.status, 200, url); return res.json();
}
const root = `/api/sessions/${prior.projectId}`;
assert.equal((await get(root)).name, 'WSL parity verified');
assert.equal((await get('/api/state/active-session')).sessionId, prior.projectId);
assert.equal((await get(root + '/files/read?path=docs/renamed.txt')).content, 'Hello WSL — café\n');
assert.equal((await get('/api/settings/harnesses')).settings.codex.defaultMode, 'pretty');
const threads = await get(root + '/terminals');
assert.ok(threads.some(t => t.status === 'queued' && t.type === 'codex'));
assert.equal((await get(`/api/terminals/${prior.terminalId}`)).label, 'Verified terminal');
// PTY scrollback is an in-memory ring on every platform; terminal metadata is durable.
const scrollbackBytesAfterRestart = (await get(`/api/terminals/${prior.terminalId}/scrollback`)).totalBytes;
const res = await fetch(base + `/api/terminals/${prior.terminalId}/relaunch`, { method: 'POST' });
assert.equal(res.status, 200, await res.text());
const ws = new WebSocket(base.replace(/^http/, 'ws') + `/api/terminals/${prior.terminalId}/ws?cols=100&rows=30`);
let output = '';
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(output)), 15000);
    ws.on('error', reject);
    ws.on('open', () => ws.send("printf 'RECOVERY-%s\\n' 'actual-output'\r"));
    ws.on('message', data => { output += data; if (output.includes('RECOVERY-actual-output')) { clearTimeout(timer); resolve(); } });
  });
} finally { ws.close(); }
const report = { at: new Date().toISOString(), status: 'pass', scrollbackBytesAfterRestart, projectId: prior.projectId, checks: ['project', 'active project', 'edited file', 'harness settings', 'queued agent', 'thread metadata', 'shell relaunch and I/O'] };
fs.writeFileSync(path.join(os.homedir(), 'dispatch-parity-recovery.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
