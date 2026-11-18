#!/usr/bin/env node
// The proof's stand-in for what a harness does with the MCP servers the daemon gave its thread.
// The stand-in `claude` has no MCP client, so the process it starts (this file) takes the harness's own
// argument list and environment, reads the thread's MCP config the way a harness does, and uses the
// servers in it. It runs AS A WORKLOAD: a child of the harness process the daemon started.
//
//   agent-work.mjs inbox <label> -- <the harness's arguments>   hand the person a CSV file and a secret through the Inbox tool
//   agent-work.mjs live  <label> -- <the harness's arguments>   wait for the tools of a system the person connects mid-thread
//
// It writes $HOME/proof/<mode>-<label>.json and, last, $HOME/proof/<mode>-<label>.done.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const [mode, label, , ...harnessArgs] = process.argv.slice(2);
const OUT = path.join(process.env.HOME || '/tmp', 'proof');
const result = { mode, label, uid: process.getuid(), cwd: process.cwd(), steps: {} };
const step = (name, value) => { result.steps[name] = value; };
const finish = () => {
  fs.writeFileSync(path.join(OUT, `${mode}-${label}.json`), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(OUT, `${mode}-${label}.done`), 'done\n');
  process.exit(0);
};
process.on('uncaughtException', (e) => { step('error', String(e && e.stack || e)); finish(); });
process.on('unhandledRejection', (e) => { step('error', String(e && e.stack || e)); finish(); });
setTimeout(() => { step('timeout', true); finish(); }, 150_000);

// A thread's key comes as a variable, or as the path of a key file (the terminal view of some harnesses).
if (!process.env.DISPATCH_AUTH && process.env.DISPATCH_AUTH_FILE) {
  try { process.env.DISPATCH_AUTH = fs.readFileSync(process.env.DISPATCH_AUTH_FILE, 'utf8').trim(); } catch { /* reported by the first call */ }
}
result.keyFrom = process.env.DISPATCH_AUTH_FILE ? 'file' : process.env.DISPATCH_AUTH ? 'variable' : 'none';

const expand = (v) => (typeof v === 'string' ? v.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_, n) => process.env[n] ?? '') : v);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function servers() {
  const i = harnessArgs.indexOf('--mcp-config');
  if (i < 0) return null;
  result.mcpConfig = harnessArgs[i + 1];
  return JSON.parse(fs.readFileSync(harnessArgs[i + 1], 'utf8')).mcpServers ?? {};
}

/** A stdio MCP server, started the way a harness starts one: the config's command, arguments and environment. */
function stdio(spec, extraEnv = {}) {
  const env = { ...process.env, ...Object.fromEntries(Object.entries(spec.env ?? {}).map(([k, v]) => [k, expand(v)])), ...extraEnv };
  const child = spawn(spec.command, spec.args ?? [], { cwd: process.cwd(), env, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map(); const notes = []; let buf = ''; let err = '';
  child.stderr.on('data', (d) => { err += d; });
  child.stdout.on('data', (d) => {
    buf += d;
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id !== undefined && m.id !== null && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
      else if (m.method) notes.push(m);
    }
  });
  let id = 0;
  const call = (method, params = {}) => new Promise((resolve) => {
    const my = ++id;
    const t = setTimeout(() => { waiting.delete(my); resolve({ error: { message: `no answer to ${method} in 30 s`, stderr: err.slice(-300) } }); }, 30_000);
    waiting.set(my, (m) => { clearTimeout(t); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: my, method, params }) + '\n');
  });
  const notify = (method) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
  return { call, notify, notes, stop: () => { try { child.kill(); } catch { /* gone */ } }, stderr: () => err };
}

const INIT = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'proof-harness', version: '1' } };
const api = (process.env.DISPATCH_API || '').replace(/\/$/, '');
const key = process.env.DISPATCH_AUTH || '';
/** One request to the daemon with this thread's own key. */
async function daemon(method, route, body) {
  try {
    const res = await fetch(api + route, { method, headers: { Authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000) });
    const text = await res.text();
    return { status: res.status, text };
  } catch (e) { return { status: 0, text: String(e) }; }
}

async function inbox() {
  const all = servers();
  step('servers', all ? Object.keys(all) : null);
  const spec = all?.['plugin-previews'];
  step('serverInConfig', !!spec);
  if (!spec) return;
  const csv = path.join(process.cwd(), `report-${label}.csv`);
  fs.writeFileSync(csv, 'region,units\nnorth,12\nsouth,30\n');
  const s = stdio(spec);
  const init = await s.call('initialize', INIT);
  step('initialize', init.result ? { serverInfo: init.result.serverInfo } : init);
  s.notify('notifications/initialized');
  const list = await s.call('tools/list');
  step('tools', (list.result?.tools ?? []).map((t) => ({ name: t.name, title: t.title ?? null })));
  const sent = await s.call('tools/call', { name: 'preview', arguments: { kind: 'table', paths: [path.basename(csv)], title: `Units by region (${label})`, note: 'proof: a CSV from the agent' } });
  const sentText = sent.result?.content?.[0]?.text ?? JSON.stringify(sent);
  step('sendCsv', { isError: sent.result?.isError === true, text: sentText });
  let dropId = null; try { dropId = JSON.parse(sentText).id ?? null; } catch { /* an error text */ }
  result.dropId = dropId;
  // A secret drop: the value is handed over by the proof script in a file it removes afterwards.
  let secretValue = null;
  try { secretValue = fs.readFileSync(path.join(OUT, 'secret-value'), 'utf8').trim(); } catch { /* none */ }
  if (secretValue) {
    const sec = await s.call('tools/call', { name: 'preview', arguments: { kind: 'secret', text: secretValue, title: `A token (${label})` } });
    const secText = sec.result?.content?.[0]?.text ?? JSON.stringify(sec);
    step('sendSecret', { isError: sec.result?.isError === true, text: secText });
    try { result.secretDropId = JSON.parse(secText).id ?? null; } catch { result.secretDropId = null; }
  }
  await sleep(1500); // the tool prunes in the background after each post
  s.stop();
  // What this thread's own key gets on the owner's Inbox routes.
  const asThread = {};
  for (const [name, method, route] of [
    ['list', 'GET', '/api/inbox'], ['counts', 'GET', '/api/inbox/unread'],
    ['one drop', 'GET', `/api/inbox/drops/${dropId}`], ['mark read', 'POST', `/api/inbox/drops/${dropId}/read`],
  ]) asThread[name] = (await daemon(method, route)).status;
  step('ownerRoutesAsThread', asThread);
  // The file the drop lists, asked with the thread's key through both routes that serve bytes.
  const mine = await daemon('GET', `/api/plugins/previews/data/preview:${dropId}`);
  let fileId = null; try { fileId = JSON.parse(mine.text).value.files[0].fileId; } catch { /* no file */ }
  result.fileId = fileId;
  step('fileRoutesAsThread', {
    inbox: (await daemon('GET', `/api/inbox/drops/${dropId}/files/${fileId}`)).status,
    plugin: (await daemon('GET', `/api/plugins/previews/files/${fileId}`)).status,
  });
}

/** Read an event stream until a JSON-RPC notification with `method` arrives (or the signal aborts). */
async function waitOnStream(url, headers, method, signal, opened) {
  const res = await fetch(url, { headers: { accept: 'text/event-stream', ...headers }, signal });
  if (res.status !== 200) return { status: res.status };
  opened();
  let buf = '';
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
    const blocks = buf.split('\n\n'); buf = blocks.pop() ?? '';
    for (const b of blocks) {
      const data = b.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
      if (!data) continue;
      try { if (JSON.parse(data).method === method) return { status: 200, got: true }; } catch { /* not JSON */ }
    }
  }
  return { status: 200, got: false };
}

async function live() {
  const all = servers();
  step('servers', all ? Object.keys(all) : null);
  const erp = all?.erp;
  step('hasServer', !!erp);
  if (!erp) return;
  const url = expand(erp.url ?? `${api}/api/os/mcp/erp`);
  const headers = Object.fromEntries(Object.entries(erp.headers ?? { Authorization: 'Bearer ${DISPATCH_AUTH}' }).map(([k, v]) => [k, expand(v)]));
  step('transport', erp.url ? 'http' : 'stdio');
  const rpc = async (method, params = {}) => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20_000) });
    return res.json().catch(() => ({}));
  };
  const init = await rpc('initialize', INIT);
  step('listChangedDeclared', init.result?.capabilities?.tools?.listChanged === true);
  const before = ((await rpc('tools/list')).result?.tools ?? []).map((t) => t.name);
  step('toolsBefore', before);
  const connect = await rpc('tools/call', { name: 'connect', arguments: {} });
  step('connectText', (connect.result?.content ?? []).map((c) => String(c.text ?? '').slice(0, 90)));
  // The same server through the stdio bridge (a harness that takes no HTTP entry runs it).
  const bridge = stdio({ command: 'node', args: ['/app/packages/core/dist/os/os-mcp-bridge.js'], env: {} }, { DISPATCH_API: api, DISPATCH_OS_SYSTEM: 'erp', DISPATCH_AUTH: key });
  const bInit = await bridge.call('initialize', INIT);
  step('bridgeInit', bInit.result ? { listChanged: bInit.result.capabilities?.tools?.listChanged === true } : bInit);
  // The event stream of the HTTP entry.
  const ac = new AbortController();
  let streamOpen = false;
  const streamed = waitOnStream(url, headers, 'notifications/tools/list_changed', ac.signal, () => { streamOpen = true; }).catch((e) => ({ error: String(e) }));
  for (let i = 0; i < 50 && !streamOpen; i++) await sleep(100);
  step('streamOpened', streamOpen);
  // Tell the proof script that both listeners wait; it then "connects" the system on the platform.
  fs.writeFileSync(path.join(OUT, `live-${label}.ready`), 'ready\n');
  const deadline = Date.now() + 90_000;
  let viaBridge = false;
  let viaStream = null;
  streamed.then((v) => { viaStream = v; });
  while (Date.now() < deadline && !(viaBridge && viaStream)) {
    viaBridge = bridge.notes.some((n) => n.method === 'notifications/tools/list_changed');
    await sleep(200);
  }
  ac.abort();
  step('viaStream', viaStream?.got === true);
  step('viaBridge', viaBridge);
  step('toolsAfter', ((await rpc('tools/list')).result?.tools ?? []).map((t) => t.name));
  const viaBridgeList = await bridge.call('tools/list');
  step('bridgeToolsAfter', (viaBridgeList.result?.tools ?? []).map((t) => t.name));
  bridge.stop();
}

/**
 * A thread reads the owner's other threads through Dispatch's own server (`dispatch`): list_threads,
 * then read_thread of the thread named in $HOME/proof/tid. Then the same key on owner-level routes.
 */
async function threads() {
  const all = servers();
  step('servers', all ? Object.keys(all) : null);
  // The launch layer of the hosted MCP rule, as the harness received it.
  step('launch', { strictMcpConfig: harnessArgs.includes('--strict-mcp-config'), claudeAiConnectorsEnv: process.env.ENABLE_CLAUDEAI_MCP_SERVERS ?? null });
  const spec = all?.dispatch;
  step('serverInConfig', !!spec);
  if (!spec) return;
  let target = '';
  try { target = fs.readFileSync(path.join(OUT, 'tid'), 'utf8').trim(); } catch { /* none */ }
  const s = stdio(spec);
  const init = await s.call('initialize', INIT);
  step('initialize', init.result ? { serverInfo: init.result.serverInfo } : init);
  s.notify('notifications/initialized');
  const names = ((await s.call('tools/list')).result?.tools ?? []).map((t) => t.name);
  step('tools', names.filter((n) => /thread|project/.test(n)));
  step('statusTool', names.includes('report_status'));
  const text = (r) => r.result?.content?.[0]?.text ?? JSON.stringify(r.error ?? r);
  const listed = await s.call('tools/call', { name: 'list_threads', arguments: {} });
  let rows = []; try { rows = JSON.parse(text(listed)); } catch { /* an error text */ }
  step('listThreads', { isError: listed.result?.isError === true, count: Array.isArray(rows) ? rows.length : 0, target: (Array.isArray(rows) ? rows : []).find((r) => r.id === target)?.label ?? null, text: Array.isArray(rows) ? undefined : text(listed).slice(0, 200) });
  const read = await s.call('tools/call', { name: 'read_thread', arguments: { id: target, tail: 20 } });
  const readText = text(read);
  step('readThread', { isError: read.result?.isError === true, hasFirstTurn: readText.includes('echo:first turn'), text: readText.slice(0, 160) });
  s.stop();
  // The same key on routes that only the owner may use: settings, accounts, approvals, tokens, secrets.
  const asThread = {};
  for (const [name, method, route, body] of [
    ['harness settings', 'PUT', '/api/settings/harnesses', { 'claude-code': { defaultModel: 'x' } }],
    ['claude account sign-in', 'POST', '/api/claude-auth/login', {}],
    ['answer an approval', 'POST', `/api/terminals/${target}/permission`, { decision: 'allow' }],
    ['devices and tokens', 'GET', '/api/access/devices'],
    ['secrets', 'GET', '/api/secrets'],
    ['message another thread', 'POST', `/api/terminals/${target}/message`, { text: 'hi', source: 'coordinator' }],
  ]) asThread[name] = (await daemon(method, route, body)).status;
  step('ownerRoutesAsThread', asThread);
}

await (mode === 'inbox' ? inbox() : mode === 'live' ? live() : mode === 'threads' ? threads() : Promise.resolve(step('error', `unknown mode ${mode}`)));
finish();
