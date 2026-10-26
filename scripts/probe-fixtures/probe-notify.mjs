#!/usr/bin/env node
// Probe fixture: same shape as packages/core/scripts/codex-notify.mjs, plus a credential.
// Codex runs it as: node THIS URL [KEYFILE] PAYLOAD (the event JSON is appended last).
// The key comes from DISPATCH_AUTH in the inherited env; else from the file named by the optional
// third argument (a path is not secret). The header X-Probe-Via tells the fake daemon which source
// supplied the key: env, file, or none. Best-effort and silent.
import fs from 'node:fs';

const url = process.argv[2];
const payload = process.argv[process.argv.length - 1];
const keyFile = process.argv.length > 4 ? process.argv[3] : '';
if (!url || !payload || payload === url) process.exit(0);

let body = payload;
try { JSON.parse(payload); } catch { body = '{}'; }

let key = process.env.DISPATCH_AUTH || '';
let via = key ? 'env' : 'none';
if (!key && keyFile) {
  try { key = fs.readFileSync(keyFile, 'utf8').trim(); via = key ? 'file' : 'none'; } catch { /* none */ }
}
const headers = { 'content-type': 'application/json', 'x-probe-src': 'notify', 'x-probe-via': via, 'x-probe-label': process.env.PROBE_LABEL || '' };
if (key) headers.authorization = `Bearer ${key}`;

fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(4000) })
  .catch(() => {})
  .finally(() => process.exit(0));
