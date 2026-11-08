#!/usr/bin/env node
// Seeds an ISOLATED Dispatch daemon so every Settings section has content to screenshot.
// Never point this at the real ~/.dispatch: run.sh gives the daemon a fake HOME.
//
// Three phases, run.sh calls them in this order:
//   node seed.mjs files <fakeHome>                 before the first start: files the daemon reads at boot
//   node seed.mjs api   <url> [ownerTokenFile]     daemon running: projects, threads, skills, ...
//   node seed.mjs db    <fakeHome>                 daemon STOPPED: rows written straight into the SQLite DB
//
// A loopback caller is the owner, so the token file is optional (it is sent as a Bearer token
// when given, for a daemon reached over a LAN address).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const [phase, target, tokenFile] = process.argv.slice(2);
const log = (...a) => console.log('[seed]', ...a);

/** The fake Claude token of the added "Work" account. Its hash names the account the limit figures belong to. */
const WORK_TOKEN = 'sk-ant-oat01-settings-shots-fake-token-not-real';
const tokenAccountId = (t) => `token:${crypto.createHash('sha256').update(t).digest('hex').slice(0, 16)}`;

const PROJECTS = [
  { name: 'dispatch', dir: 'Sites/dispatch' },
  { name: 'storefront', dir: 'Sites/storefront' },
  { name: 'data-warehouse', dir: 'Sites/data-warehouse' },
  { name: 'mobile-app', dir: 'Sites/mobile-app' },
  { name: 'infra', dir: 'Sites/infra' },
  { name: 'docs-site', dir: 'Sites/docs-site' },
];

function phaseFiles(home) {
  const data = path.join(home, '.dispatch');
  fs.mkdirSync(data, { recursive: true, mode: 0o700 });
  // Project folders: a project needs a working directory that exists.
  for (const p of PROJECTS) fs.mkdirSync(path.join(home, p.dir), { recursive: true });
  // Accounts: the CLI login is always there; add one more Claude account and one Codex account.
  // The Codex folder has no auth.json, so it shows as "not signed in" (an honest state, no login needed).
  const codexDir = path.join(data, 'codex-accounts', 'personal');
  fs.mkdirSync(codexDir, { recursive: true });
  const now = new Date(Date.now() - 6 * 86400_000).toISOString();
  fs.writeFileSync(path.join(data, 'accounts.json'), JSON.stringify({
    claude: [{ id: 'work', label: 'Work', email: 'dev@example.com', plan: 'Max', token: WORK_TOKEN, addedAt: now }],
    codex: [{ id: 'personal', label: 'Personal', email: 'me@example.com', dir: codexDir, addedAt: now }],
    defaults: { claude: 'cli', codex: 'cli' },
  }, null, 2), { mode: 0o600 });
  log('files: accounts.json (Claude "Work", Codex "Personal"), project folders');
}

async function phaseApi(base) {
  base = base.replace(/\/+$/, '');
  const auth = tokenFile ? { Authorization: `Bearer ${fs.readFileSync(tokenFile, 'utf8').trim()}` } : {};
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...auth, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${text.slice(0, 200)}`);
    return json;
  };
  const tryCall = async (what, fn) => { try { const r = await fn(); log('ok  ', what); return r; } catch (e) { log('SKIP', what, '—', e.message); return null; } };

  await tryCall('setup complete', () => call('POST', '/api/setup/complete'));

  // The daemon's HOME (run.sh sets SEED_HOME): the project folders the files phase made live there.
  const home = process.env.SEED_HOME ?? os.homedir();
  const projects = [];
  for (const p of PROJECTS) {
    const s = await tryCall(`project ${p.name}`, () => call('POST', '/api/sessions', { provider: 'shell', name: p.name, workingDir: path.join(home, p.dir) }));
    if (s) projects.push(s);
  }
  // Threads: shell threads only (a Claude or Codex thread would start the CLI under the fake HOME).
  for (const [i, s] of projects.slice(0, 3).entries()) {
    for (const label of ['Fix the login redirect', 'Write release notes'].slice(0, i === 0 ? 2 : 1)) {
      await tryCall(`thread ${s.name}/${label}`, () => call('POST', `/api/sessions/${s.id}/terminals`, { type: 'shell', label }));
    }
  }

  // Skills: two, one for every project and one for a single project, plus one turned off.
  const pid = projects[1]?.id;
  await tryCall('skill house-style', () => call('POST', '/api/skills', { id: 'house-style', name: 'House style', description: 'US spelling, short sentences, no emoji.', body: '# House style\n\nWrite in US English. Keep sentences short.' }));
  await tryCall('skill release-checklist', () => call('POST', '/api/skills', { id: 'release-checklist', name: 'Release checklist', description: 'Bump all four package.json files, write the note, tag.', body: '# Release checklist\n\n1. Bump versions.\n2. Write the note.\n3. Tag.', ...(pid ? { projects: [pid] } : {}) }));
  await tryCall('skill sql-review', () => call('POST', '/api/skills', { id: 'sql-review', name: 'SQL review', description: 'Check every query for an index and a LIMIT.', body: '# SQL review\n\nCheck indexes.' }));
  await tryCall('skill sql-review off', () => call('POST', '/api/skills/sql-review/disable', {}));

  // Integrations: one stdio, one remote, one turned off.
  await tryCall('integration github', () => call('POST', '/api/integrations', { type: 'stdio', name: 'github', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } }));
  await tryCall('integration linear', () => call('POST', '/api/integrations', { type: 'remote', name: 'linear', url: 'https://mcp.linear.app/sse' }));
  const pg = await tryCall('integration postgres', () => call('POST', '/api/integrations', { type: 'stdio', name: 'postgres', command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://localhost/app'] }));
  if (pg?.id) await tryCall('integration postgres off', () => call('PATCH', `/api/integrations/${pg.id}`, { enabled: false }));

  // Servers: two other machines.
  await tryCall('server mac-mini', () => call('POST', '/api/servers', { label: 'Mac mini', origin: 'https://mini.example.ts.net:8443' }));
  await tryCall('server laptop', () => call('POST', '/api/servers', { label: 'Laptop', origin: 'http://192.168.1.40:3456' }));

  // Devices: two phones signed in with a pairing code, then named.
  const ua = {
    iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1',
    ipad: 'Mozilla/5.0 (iPad; CPU OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1',
  };
  for (const [name, agent] of Object.entries(ua)) {
    await tryCall(`device ${name}`, async () => {
      const { code } = await call('POST', '/api/access/pair-code');
      const res = await fetch(base + '/api/access/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': agent }, body: JSON.stringify({ code }) });
      if (!res.ok) throw new Error(`login ${res.status} ${await res.text()}`);
    });
  }
  const devices = await tryCall('list devices', () => call('GET', '/api/access/devices'));
  const list = devices?.devices ?? (Array.isArray(devices) ? devices : []);
  const names = ['David’s iPhone', 'iPad'];
  for (const [i, d] of list.filter((d) => d && d.id).slice(0, 2).entries()) {
    await tryCall(`rename device ${d.id}`, () => call('PATCH', `/api/access/devices/${d.id}`, { name: names[i] }));
  }

  // Push subscriptions: two phones (FCM is the one host the daemon accepts without a real Apple endpoint).
  for (const [i, agent] of Object.values(ua).entries()) {
    await tryCall(`push subscription ${i}`, () => call('POST', '/api/push/subscribe', {
      deviceId: `shots-device-${i}`,
      subscription: { endpoint: `https://fcm.googleapis.com/fcm/send/shots-${i}-${crypto.randomUUID()}`, keys: { p256dh: crypto.randomBytes(65).toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } },
    }, { 'User-Agent': agent }));
  }

  // A local plugin, so Settings → Plugins has a LOCAL row next to the bundled ones.
  await tryCall('local plugin', () => call('POST', '/api/plugins/scaffold', { id: 'daily-rundown', name: 'Daily rundown' }));
}

function phaseDb(home) {
  const dbFile = path.join(home, '.dispatch', 'dispatch.db');
  if (!fs.existsSync(dbFile)) { log('SKIP db: no', dbFile); return; }
  const now = Date.now();
  const h = 3600_000;
  // Usage-limit figures (limits/snapshot.ts). Under the fake HOME the CLI login's account id is '',
  // the added Claude account's is the hash of its token, an added Codex folder with no login is `acct:<id>`.
  const win = (pct, resetIn) => ({ usedPercent: pct, resetsAt: now + resetIn });
  const snap = (account, plan, windows) => ({ account, asOf: now, plan, windows, figureAt: Object.fromEntries(Object.keys(windows).map((k) => [k, now])) });
  const snapshots = {
    'claude-code': { ...snap('', 'Max', { five_hour: win(42, 2.5 * h), seven_day: win(71, 3 * 24 * h), seven_day_opus: win(18, 3 * 24 * h) }), spend: { usedMinor: 1240, limitMinor: 5000, currency: 'USD' } },
    'claude-code@work': snap(tokenAccountId(WORK_TOKEN), 'Max', { five_hour: win(88, 1.2 * h), seven_day: win(54, 5 * 24 * h) }),
    codex: snap('', 'Pro', { five_hour: win(12, 4 * h), seven_day: win(33, 6 * 24 * h) }),
  };
  const sql = `INSERT OR REPLACE INTO app_state(key, value) VALUES ('usage_limit_snapshots', '${JSON.stringify(snapshots).replace(/'/g, "''")}');`;
  execFileSync('sqlite3', [dbFile, sql]);
  log('db: usage-limit figures for Claude (CLI + Work) and Codex');
}

if (phase === 'files' && target) phaseFiles(target);
else if (phase === 'api' && target) await phaseApi(target);
else if (phase === 'db' && target) phaseDb(target);
else { console.error('usage: seed.mjs files <fakeHome> | api <url> [ownerTokenFile] | db <fakeHome>'); process.exit(2); }
