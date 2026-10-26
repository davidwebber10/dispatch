// Manual delivery probe for per-thread keys (spec 6.3, plan 2026-10-23 stage 1, Task 1).
// It answers: for each harness and view, does a per-thread key in `DISPATCH_AUTH` reach the MCP
// helper, the shell, the hook and the notify helper of that thread, and nowhere else?
//
// Needs signed-in `claude`, `codex`, `grok` and `opencode` CLIs. It uses the real config homes
// read-only and never copies a sign-in file. Run it from packages/core with a CLEAN env, so no
// live DISPATCH_* variable reaches it (the shell here has none either, but be sure):
//
//   cd packages/core
//   env -i HOME="$HOME" USER="$USER" LOGNAME="$LOGNAME" SHELL="$SHELL" LANG="$LANG" \
//     PATH="$(dirname "$(command -v node)"):/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
//     node --import tsx ../../scripts/key-delivery-probe.mjs SECTIONS
//
// SECTIONS is a comma list of: codex-pretty, codex-cli, claude, grok, opencode-ref, opencode-literal.
//
// Safety rules the probe keeps:
//   - The fake daemon binds a free port chosen by the OS. Never port 3456, never ~/.dispatch.
//   - Each canary key is made in memory. It goes only into env, a thread config sent over a pipe,
//     or (for the opencode literal row) one 0600 file in the scratch folder. Never into argv.
//   - The probe never prints a canary. It prints labels only. Its scan reads files as bytes and
//     looks for the canaries it holds in memory.
//   - It kills only the processes it starts, by pid.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { CodexStructuredSessionManager } from '../packages/core/src/structured/codex-manager.ts';
import { GrokStructuredSessionManager } from '../packages/core/src/structured/grok-manager.ts';
import { codexProvider } from '../packages/core/src/providers/codex.ts';
import { writeGrokHome } from '../packages/core/src/providers/grok-home.ts';
import { writeOpencodeConfig } from '../packages/core/src/providers/opencode-config.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FX = path.join(ROOT, 'scripts', 'probe-fixtures');
const NODE = process.execPath;
const HOME = os.homedir();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sections = (process.argv[2] || '').split(',').filter(Boolean);
if (!sections.length) { console.error('usage: key-delivery-probe.mjs codex-pretty,codex-cli,claude,grok,opencode-ref,opencode-literal'); process.exit(2); }

// A clean env is the contract. Refuse to run when a Dispatch variable is present.
const dirty = Object.keys(process.env).filter((k) => k.startsWith('DISPATCH_'));
if (dirty.length) { console.error(`refusing to run: ${dirty.join(', ')} set in the probe env; use env -i`); process.exit(2); }

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-probe-run.'));
const WORK = path.join(SCRATCH, 'work');
fs.mkdirSync(WORK, { recursive: true });
const T0 = Date.now();
const out = (...a) => console.log(...a);

// ---- canaries ------------------------------------------------------------------------------
const canaries = new Map(); // key -> label such as "A#1"
const counts = new Map();
const mint = (label) => {
  const n = (counts.get(label) ?? 0) + 1; counts.set(label, n);
  const key = 'dtk_' + crypto.randomBytes(32).toString('base64url');
  canaries.set(key, `${label}#${n}`);
  return key;
};
const redact = (s) => { let r = String(s); for (const [k, l] of canaries) r = r.split(k).join(`[canary ${l}]`); return r; };

// ---- leak taps (in memory) ------------------------------------------------------------------
const leaks = []; // { where, label }
const leak = (where, label) => { if (!leaks.some((l) => l.where === where && l.label === label)) leaks.push({ where, label }); };
const makeTap = (where) => {
  let tail = '';
  return (chunk) => {
    const s = tail + (typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    for (const [k, label] of canaries) if (s.includes(k)) leak(where, label);
    tail = s.slice(-80);
  };
};

// ---- fake daemon ----------------------------------------------------------------------------
const hits = []; // { src, path, label, claimed, via }
const server = http.createServer((req, res) => {
  const auth = String(req.headers.authorization || '');
  const v = auth.replace(/^Bearer\s*/i, '');
  let label;
  if (!auth) label = 'none';
  else if (!v) label = 'empty';
  else if (canaries.has(v)) label = canaries.get(v);
  else if (v.includes('${')) label = 'literal-ref';
  else label = 'unknown-credential';
  const src = String(req.headers['x-probe-src'] || req.url.split('/')[2] || '?');
  hits.push({ src, path: req.url, label, claimed: String(req.headers['x-probe-label'] || ''), via: String(req.headers['x-probe-via'] || '') });
  req.resume();
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{}');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
if (PORT === 3456) { console.error('port 3456 is forbidden'); process.exit(2); }
const FAKE = `http://127.0.0.1:${PORT}`;
const hitsFor = (claimed, from = 0, src) => hits.slice(from).filter((h) => h.claimed === claimed && (!src || h.src === src));
const fmt = (hs) => (hs.length ? hs.map((h) => `${h.src}:${h.label}${h.via ? `/via-${h.via}` : ''}`).join(', ') : '(no request)');
const waitFor = async (cond, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await sleep(250); } return cond(); };

const baseEnv = () => ({ ...process.env });
const prompt = (label) => `Call the probe_call tool. Then run this shell command exactly: ${NODE} ${path.join(FX, 'probe-shell.mjs')} ${label} . Then reply with the single word done.`;
const results = [];
const row = (name, outcome) => { results.push([name, outcome]); out(`ROW ${name} :: ${outcome}`); };

// a note about the base label of a canary label: "A#2" -> "A"
const baseOf = (l) => l.split('#')[0];
const verdict = (claimed, hs) => {
  if (!hs.length) return 'no request';
  const bad = hs.filter((h) => h.label.startsWith('literal') || ['none', 'empty', 'unknown-credential'].includes(h.label) || baseOf(h.label) !== claimed);
  return bad.length ? `WRONG (${fmt(hs)})` : `own canary (${fmt(hs)})`;
};

// ---- Codex Pretty ---------------------------------------------------------------------------
async function codexPretty() {
  const m = new CodexStructuredSessionManager();
  const { command, args } = codexProvider.buildStructuredCommand({});
  const tapRpc = makeTap('codex-pretty rpc responses/notifications');
  const tapOut = makeTap('codex app-server stdout');
  const tapErr = makeTap('codex app-server stderr');
  const tapEv = makeTap('codex manager events');
  const origMake = m.makeConnection.bind(m);
  m.makeConnection = (spec) => {
    const conn = origMake(spec);
    const origReq = conn.request.bind(conn);
    conn.request = async (method, params, t) => {
      try { const r = await origReq(method, params, t); tapRpc(`${method} ${JSON.stringify(r)}`); return r; }
      catch (e) { tapRpc(`${method} error ${e?.message}`); throw e; }
    };
    conn.on('notification', (meth, p) => tapRpc(`${meth} ${JSON.stringify(p)}`));
    conn.on('server-request', (meth, id, p) => tapRpc(`${meth} ${JSON.stringify(p)}`));
    conn.child.stdout.on('data', (d) => tapOut(d));
    conn.child.stderr.on('data', (d) => tapErr(d));
    return conn;
  };
  m.on('event', (_id, ev) => { try { tapEv(JSON.stringify(ev)); } catch { /* ignore */ } });
  const texts = new Map();
  m.on('failed', (id) => out(`  (failed event: ${id})`));

  const cfgFor = (label, key) => ({
    'mcp_servers.dispatch': { command: NODE, args: [path.join(FX, 'probe-mcp.mjs')], env: { DISPATCH_AUTH: key, DISPATCH_API: FAKE, PROBE_LABEL: label } },
    'shell_environment_policy.set.DISPATCH_AUTH': key,
    'shell_environment_policy.set.DISPATCH_API': FAKE,
  });
  const spawnT = (label, extra = {}) => {
    const key = mint(label);
    m.spawn(label, {
      command, args, workDir: WORK, env: {}, escalate: false, model: 'gpt-5.6-luna',
      approvalPolicy: 'never', sandbox: 'danger-full-access', threadConfig: cfgFor(label, key), ...extra,
    });
  };
  const turn = (id, text, ms = 150000) => new Promise((resolve) => {
    let done = false;
    const fin = (r) => { if (done) return; done = true; m.off('idle', onI); m.off('failed', onF); m.off('exit', onX); resolve(r); };
    const onI = (tid) => { if (tid === id) fin('idle'); };
    const onF = (tid) => { if (tid === id) fin('failed'); };
    const onX = (tid) => { if (tid === id) fin('killed'); };
    m.on('idle', onI); m.on('failed', onF); m.on('exit', onX);
    setTimeout(() => fin('timeout'), ms).unref();
    m.sendMessage(id, text);
  });
  const lastText = (id) => redact((m.getTurnTexts(id) ?? []).join(' ').slice(0, 120));

  // 1. five threads on one app-server. Z is an idle anchor so the app-server stays up.
  spawnT('Z');
  for (const l of ['A', 'B', 'C', 'D']) spawnT(l);
  const longPrompt = (l) => `Call the probe_call tool. Then run this shell command exactly: ${NODE} ${path.join(FX, 'probe-shell.mjs')} ${l} . Then run the shell command: sleep 40 . Then reply with the single word done.`;
  const pA = turn('A', prompt('A'));
  const pB = turn('B', prompt('B'));
  turn('C', longPrompt('C'));
  turn('D', longPrompt('D'));
  const [rA, rB] = await Promise.all([pA, pB]);
  out(`  first turns: A=${rA} B=${rB}`);
  for (const l of ['A', 'B']) {
    row(`codex-pretty first turn thread ${l}: MCP`, verdict(l, hitsFor(l, 0, 'mcp')));
    row(`codex-pretty first turn thread ${l}: shell (policy.set)`, verdict(l, hitsFor(l, 0, 'shell')));
  }
  await waitFor(() => hitsFor('C', 0, 'shell').length && hitsFor('D', 0, 'shell').length, 90000);
  for (const l of ['C', 'D']) {
    row(`codex-pretty first turn thread ${l}: MCP`, verdict(l, hitsFor(l, 0, 'mcp')));
    row(`codex-pretty first turn thread ${l}: shell (policy.set)`, verdict(l, hitsFor(l, 0, 'shell')));
  }

  // 2. resume cases. The new canary is minted at respawn; the old one stays in the map.
  const resumeCase = async (name, id, waitBeforeKill, delayAfterKill) => {
    if (waitBeforeKill) await waitBeforeKill();
    const sid = m.getSessionId(id);
    if (!sid) { row(name, 'no thread id (cannot resume)'); return; }
    m.kill(id);
    await sleep(delayAfterKill);
    const from = hits.length;
    spawnT(id, { resumeId: sid });
    const r = await turn(id, prompt(id), 120000);
    const mcp = hitsFor(id, from, 'mcp'); const sh = hitsFor(id, from, 'shell');
    const which = (hs) => (hs.length ? hs.map((h) => (h.label === `${id}#${counts.get(id)}` ? 'NEW' : h.label.startsWith(`${id}#`) ? 'OLD' : h.label)).join('+') : 'NONE');
    row(name, `turn=${r}; MCP canary: ${which(mcp)} (${fmt(mcp)}); shell canary: ${which(sh)} (${fmt(sh)}); reply: "${lastText(id)}"`);
  };
  const afterShell = (id) => async () => { await waitFor(() => hitsFor(id, 0, 'shell').length > 0, 90000); await sleep(2000); };
  await Promise.all([
    resumeCase('codex-pretty resume, idle thread, 3 s after kill', 'A', null, 3000),
    resumeCase('codex-pretty resume, idle thread, 16 s after kill', 'B', null, 16000),
    resumeCase('codex-pretty resume, killed during a running turn, 12 s after kill', 'C', afterShell('C'), 12000),
    resumeCase('codex-pretty resume, killed during a running turn, 16 s after kill', 'D', afterShell('D'), 16000),
  ]);

  // 3. app-server crash: SIGKILL the shared app-server, then check A and B again.
  m.kill('C'); m.kill('D');
  await sleep(2000);
  const appPid = m.conn?.pid;
  const connBefore = m.conn;
  if (appPid && appPid > 0) { try { process.kill(appPid, 'SIGKILL'); } catch { /* gone */ } }
  await waitFor(() => m.conn && m.conn !== connBefore && m.conn.alive, 20000);
  await sleep(1500);
  await Promise.all(['A', 'B'].map((l) => m.sessions.get(l)?.ready));
  const fromCrash = hits.length;
  const [cA, cB] = await Promise.all([turn('A', prompt('A')), turn('B', prompt('B'))]);
  for (const l of ['A', 'B']) {
    row(`codex-pretty after app-server SIGKILL, thread ${l}: MCP`, `turn=${l === 'A' ? cA : cB}; ${verdict(l, hitsFor(l, fromCrash, 'mcp'))}; current canary is ${l}#${counts.get(l)}`);
    row(`codex-pretty after app-server SIGKILL, thread ${l}: shell`, verdict(l, hitsFor(l, fromCrash, 'shell')));
  }
  m.killAll();
  await sleep(3000);
}

// ---- Codex CLI (PTY) ------------------------------------------------------------------------
async function codexCli() {
  const require = createRequire(path.join(ROOT, 'packages/core/package.json'));
  const pty = require('node-pty');
  const key = mint('CLI');
  const tapPty = makeTap('codex CLI pty output');
  const cwd = path.join(SCRATCH, 'codex-cli-work'); fs.mkdirSync(cwd, { recursive: true });
  const cargs = [
    '--dangerously-bypass-approvals-and-sandbox', '--no-alt-screen',
    '-c', `mcp_servers.dispatch.command=${JSON.stringify(NODE)}`,
    '-c', `mcp_servers.dispatch.args=${JSON.stringify([path.join(FX, 'probe-mcp.mjs')])}`,
    '-c', `mcp_servers.dispatch.env.DISPATCH_API=${JSON.stringify(FAKE)}`,
    '-c', 'mcp_servers.dispatch.env.PROBE_LABEL="CLI"',
    '-c', 'mcp_servers.dispatch.env_vars=["DISPATCH_AUTH"]',
    '-c', `notify=${JSON.stringify([NODE, path.join(FX, 'probe-notify.mjs'), `${FAKE}/probe/notify`])}`,
    '-c', `projects.${JSON.stringify(cwd)}.trust_level="trusted"`,
    '--model', 'gpt-5.6-luna', prompt('CLI'),
  ];
  const term = pty.spawn('codex', cargs, { name: 'xterm-256color', cols: 160, rows: 50, cwd, env: { ...baseEnv(), DISPATCH_AUTH: key, DISPATCH_API: FAKE } });
  let screen = '';
  term.onData((d) => { tapPty(d); screen = (screen + d).slice(-4000); });
  const ok = await waitFor(() => hitsFor('', 0, 'notify').length > 0 || hits.some((h) => h.src === 'notify'), 150000);
  await sleep(2000);
  try { term.kill(); } catch { /* gone */ }
  const mcp = hitsFor('CLI', 0, 'mcp'); const sh = hitsFor('CLI', 0, 'shell');
  const nt = hits.filter((h) => h.src === 'notify');
  row('codex CLI (PTY, env_vars + env): MCP', verdict('CLI', mcp));
  row('codex CLI (PTY): shell inherits env', verdict('CLI', sh));
  row('codex CLI (PTY): notify helper', nt.length ? `${nt.map((h) => `${h.label}/via-${h.via}`).join(', ')} (own canary expected: CLI#1)` : `no notify request (notify seen: ${ok})`);
  if (!mcp.length || !nt.length) out('  codex CLI screen tail: ' + redact(screen.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\s+/g, ' ').slice(-500)));
}

// ---- Claude CLI -----------------------------------------------------------------------------
async function claudeCli() {
  const key = mint('CL');
  const tapO = makeTap('claude stdout/stderr');
  const settings = path.join(SCRATCH, 'claude-settings.json');
  const mcp = path.join(SCRATCH, 'claude-mcp.json');
  fs.writeFileSync(settings, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'http', url: `${FAKE}/probe/hook`, headers: { Authorization: 'Bearer ${DISPATCH_AUTH}', 'X-Probe-Label': 'CL', 'X-Probe-Src': 'hook' }, allowedEnvVars: ['DISPATCH_AUTH'] }] }] } }));
  fs.writeFileSync(mcp, JSON.stringify({ mcpServers: { dispatch: { command: NODE, args: [path.join(FX, 'probe-mcp.mjs')], env: { DISPATCH_AUTH: '${DISPATCH_AUTH}', DISPATCH_API: FAKE, PROBE_LABEL: 'CL' } } } }));
  const text = `Call the probe_call tool, then run ${NODE} ${path.join(FX, 'probe-shell.mjs')} CL , then reply ok.`;
  const cwd = path.join(SCRATCH, 'claude-work'); fs.mkdirSync(cwd, { recursive: true });
  const child = spawn('claude', ['-p', text, '--model', 'haiku', '--settings', settings, '--mcp-config', mcp, '--strict-mcp-config', '--permission-mode', 'bypassPermissions'],
    { cwd, env: { ...baseEnv(), DISPATCH_AUTH: key, DISPATCH_API: FAKE }, stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  child.stdout.on('data', (d) => { tapO(d); buf += d; }); child.stderr.on('data', (d) => { tapO(d); buf += d; });
  const timer = setTimeout(() => { try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ } }, 150000);
  await new Promise((r) => child.on('exit', r)); clearTimeout(timer);
  row('claude CLI: MCP via ${DISPATCH_AUTH} in mcp-config env', verdict('CL', hitsFor('CL', 0, 'mcp')));
  row('claude CLI: shell', verdict('CL', hitsFor('CL', 0, 'shell')));
  const hk = hits.filter((h) => h.src === 'hook');
  row('claude CLI: HTTP Stop hook header from ${DISPATCH_AUTH}', hk.length ? hk.map((h) => h.label).join(', ') + ' (own canary expected: CL#1)' : 'no hook request');
  out('  claude reply: ' + redact(buf.replace(/\s+/g, ' ').slice(0, 160)));
}

// ---- Grok -----------------------------------------------------------------------------------
async function grok() {
  const mcpEntry = (label) => ({ dispatch: { command: NODE, args: [path.join(FX, 'probe-mcp.mjs')], env: { DISPATCH_AUTH: '${DISPATCH_AUTH}', DISPATCH_API: FAKE, PROBE_LABEL: label } } });
  const realHome = path.join(HOME, '.grok');
  // CLI view: the top-level command reads the plugin through GROK_HOME.
  {
    const key = mint('GC');
    const dir = path.join(SCRATCH, 'grok-home-cli');
    writeGrokHome({ dir, realHome, mcpServers: mcpEntry('GC') });
    const tapO = makeTap('grok CLI stdout/stderr');
    const text = `Call the probe_call tool, then run ${NODE} ${path.join(FX, 'probe-shell.mjs')} GC , then reply ok.`;
    const cwd = path.join(SCRATCH, 'grok-cli-work'); fs.mkdirSync(cwd, { recursive: true });
    const child = spawn('grok', ['--permission-mode', 'bypassPermissions', '--single', text], { cwd, env: { ...baseEnv(), GROK_HOME: dir, DISPATCH_AUTH: key, DISPATCH_API: FAKE }, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    child.stdout.on('data', (d) => { tapO(d); buf += d; }); child.stderr.on('data', (d) => { tapO(d); buf += d; });
    const timer = setTimeout(() => { try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ } }, 150000);
    await new Promise((r) => child.on('exit', r)); clearTimeout(timer);
    row('grok CLI view (GROK_HOME plugin .mcp.json, ${DISPATCH_AUTH} reference): MCP', verdict('GC', hitsFor('GC', 0, 'mcp')));
    row('grok CLI view: shell', verdict('GC', hitsFor('GC', 0, 'shell')));
    out('  grok CLI reply: ' + redact(buf.replace(/\s+/g, ' ').slice(0, 200)));
  }
  // Pretty: `grok agent --plugin-dir` over ACP, as sessions/service.ts runs it.
  {
    const key = mint('GP');
    const dir = path.join(SCRATCH, 'grok-home-pretty');
    writeGrokHome({ dir, realHome, mcpServers: mcpEntry('GP') });
    const tapE = makeTap('grok Pretty manager events');
    const m = new GrokStructuredSessionManager('grok');
    m.on('event', (_i, ev) => { try { tapE(JSON.stringify(ev)); } catch { /* ignore */ } });
    m.spawn('GP', { command: 'grok', args: ['agent', '--plugin-dir', path.join(dir, 'plugins', 'dispatch'), '--always-approve', 'stdio'], workDir: WORK, env: { DISPATCH_AUTH: key, DISPATCH_API: FAKE }, escalate: false });
    const r = await new Promise((resolve) => {
      const fin = (x) => { m.off('idle', onI); m.off('failed', onF); resolve(x); };
      const onI = (id) => { if (id === 'GP') fin('idle'); };
      const onF = (id) => { if (id === 'GP') fin('failed'); };
      m.on('idle', onI); m.on('failed', onF);
      setTimeout(() => fin('timeout'), 150000).unref();
      m.sendMessage('GP', prompt('GP'));
    });
    row('grok Pretty (--plugin-dir, ${DISPATCH_AUTH} reference): MCP', `turn=${r}; ${verdict('GP', hitsFor('GP', 0, 'mcp'))}`);
    row('grok Pretty: shell', verdict('GP', hitsFor('GP', 0, 'shell')));
    out('  grok Pretty reply: ' + redact((m.getTurnTexts?.('GP') ?? []).join(' ').slice(0, 200)));
    m.killAll?.();
    await sleep(1500);
  }
}

// ---- opencode (two threads at once, each with its own OPENCODE_CONFIG) -----------------------
const knownFiles = new Set();
async function opencode(literal) {
  const model = 'openrouter/~google/gemini-flash-latest';
  const labels = literal ? ['OL1', 'OL2'] : ['OR1', 'OR2'];
  const mgr = new GrokStructuredSessionManager('opencode');
  const tapE = makeTap('opencode manager events');
  mgr.on('event', (_i, ev) => { try { tapE(JSON.stringify(ev)); } catch { /* ignore */ } });
  const runs = labels.map((label) => {
    const key = mint(label);
    const dir = path.join(SCRATCH, `opencode-${label}`);
    const cfg = writeOpencodeConfig({
      dir, model, escalate: false,
      mcpServers: { dispatch: { command: NODE, args: [path.join(FX, 'probe-mcp.mjs')], env: { DISPATCH_AUTH: literal ? key : '{env:DISPATCH_AUTH}', DISPATCH_API: FAKE, PROBE_LABEL: label } } },
    });
    fs.chmodSync(cfg, 0o600);
    if (literal) knownFiles.add(cfg);
    mgr.spawn(label, { command: 'opencode', args: ['acp'], workDir: WORK, env: { OPENCODE_CONFIG: cfg, DISPATCH_AUTH: key, DISPATCH_API: FAKE }, escalate: false, model });
    return new Promise((resolve) => {
      const fin = (x) => { mgr.off('idle', onI); mgr.off('failed', onF); resolve(x); };
      const onI = (id) => { if (id === label) fin('idle'); };
      const onF = (id) => { if (id === label) fin('failed'); };
      mgr.on('idle', onI); mgr.on('failed', onF);
      setTimeout(() => fin('timeout'), 150000).unref();
      mgr.sendMessage(label, prompt(label));
    });
  });
  const rs = await Promise.all(runs);
  labels.forEach((l, i) => {
    row(`opencode ${literal ? 'literal in 0600 config' : '{env:DISPATCH_AUTH} reference'}, thread ${l}: MCP`, `turn=${rs[i]}; ${verdict(l, hitsFor(l, 0, 'mcp'))}`);
    row(`opencode ${literal ? 'literal' : 'reference'}, thread ${l}: shell`, verdict(l, hitsFor(l, 0, 'shell')));
    out(`  opencode ${l} reply: ` + redact((mgr.getTurnTexts?.(l) ?? []).join(' ').slice(0, 200)));
  });
  mgr.killAll?.();
  await sleep(1500);
}

// ---- scan ----------------------------------------------------------------------------------
function scanFiles() {
  const roots = [path.join(HOME, '.codex'), path.join(HOME, '.claude'), path.join(HOME, '.grok'), path.join(HOME, '.local/share/opencode'),
    path.join(HOME, '.local/state/opencode'), path.join(HOME, '.config/opencode'), path.join(HOME, '.cache/opencode'), path.join(HOME, 'Library/Logs'), SCRATCH];
  const found = new Map(); // file -> Set(label)
  const cmin = T0 - 2000;
  const prefix = Buffer.from('dtk_');
  const CH = 16 * 1024 * 1024;
  const scanFile = (file, size) => {
    let fd; try { fd = fs.openSync(file, 'r'); } catch { return; }
    try {
      const buf = Buffer.alloc(CH + 64);
      let pos = 0; let carry = 0;
      while (pos < size) {
        const n = fs.readSync(fd, buf, carry, CH, pos);
        if (n <= 0) break;
        const len = carry + n;
        let i = buf.indexOf(prefix, 0);
        while (i !== -1 && i < len) {
          if (i + 47 <= len) { const cand = buf.toString('latin1', i, i + 47); if (canaries.has(cand)) { if (!found.has(file)) found.set(file, new Set()); found.get(file).add(canaries.get(cand)); } }
          i = buf.indexOf(prefix, i + 1);
        }
        carry = Math.min(64, len); buf.copy(buf, 0, len - carry, len);
        pos += n;
      }
    } catch { /* unreadable */ } finally { fs.closeSync(fd); }
  };
  const walk = (dir) => {
    let d; try { d = fs.opendirSync(dir); } catch { return; }
    try {
      for (let e = d.readSync(); e; e = d.readSync()) {
        const p = path.join(dir, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) { walk(p); continue; }
        if (!e.isFile()) continue;
        let st; try { st = fs.statSync(p); } catch { continue; }
        if (st.mtimeMs >= cmin) scanFile(p, st.size);
      }
    } finally { d.closeSync(); }
  };
  for (const r of roots) walk(r);
  return found;
}

// ---- main ----------------------------------------------------------------------------------
const versions = {};
for (const c of ['claude', 'codex', 'grok', 'opencode']) { try { versions[c] = execSync(`${c} --version`, { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n')[0]; } catch { versions[c] = 'unavailable'; } }
out(`versions: ${JSON.stringify(versions)}`);
out(`fake daemon on a free port (not 3456); scratch folder: ${SCRATCH.replace(HOME, '~')}; sections: ${sections.join(',')}`);
const table = { 'codex-pretty': codexPretty, 'codex-cli': codexCli, claude: claudeCli, grok, 'opencode-ref': () => opencode(false), 'opencode-literal': () => opencode(true) };
for (const s of sections) {
  if (!table[s]) { out(`unknown section ${s}`); continue; }
  try { await table[s](); } catch (e) { out(`SECTION ${s} FAILED: ${redact(e?.stack || e)}`); row(`${s}`, `probe error: ${redact(e?.message || e)}`); }
}
server.close();
const found = scanFiles();
out('--- scan (labels and file names only) ---');
let any = false;
for (const [file, labels] of found) {
  if (knownFiles.has(file)) { out(`expected (probe wrote it): ${file.replace(HOME, '~')} [${[...labels].join(', ')}]`); continue; }
  any = true; out(`CANARY IN FILE: ${file.replace(HOME, '~')} [${[...labels].join(', ')}]`);
}
if (!any) out('no canary in any file modified after the start (searched the CLI homes, logs and the scratch folder)');
if (leaks.length) for (const l of leaks) out(`CANARY IN STREAM: ${l.where} [${l.label}]`); else out('no canary in any captured stream, event or JSON-RPC response');
out(`hits seen by the fake daemon: ${hits.length}`);
process.exit(0);
