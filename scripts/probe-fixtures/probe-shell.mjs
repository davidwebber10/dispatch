#!/usr/bin/env node
// Probe fixture: run as a shell command by the agent. Sends GET DISPATCH_API/probe/shell with the
// key from DISPATCH_AUTH (or the file in DISPATCH_AUTH_FILE), so the fake daemon sees which canary
// this shell holds. argv[2] is a non-secret label for the thread that should own the key.
// It prints only whether a key was present, never the key.
import fs from 'node:fs';

const api = process.env.DISPATCH_API || '';
const label = process.argv[2] || '';
let key = process.env.DISPATCH_AUTH || '';
if (!key && process.env.DISPATCH_AUTH_FILE) {
  try { key = fs.readFileSync(process.env.DISPATCH_AUTH_FILE, 'utf8').trim(); } catch { /* none */ }
}
if (!api) { console.log('shell: no DISPATCH_API, nothing sent'); process.exit(0); }
const headers = { 'x-probe-src': 'shell', 'x-probe-label': label };
if (key) headers.authorization = `Bearer ${key}`;
try {
  const r = await fetch(`${api}/probe/shell`, { headers, signal: AbortSignal.timeout(5000) });
  console.log(`shell: sent (status ${r.status}, key ${key ? 'present' : 'absent'})`);
} catch (e) {
  console.log(`shell: error ${e?.name || 'fetch'} (key ${key ? 'present' : 'absent'})`);
}
