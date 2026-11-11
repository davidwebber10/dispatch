#!/usr/bin/env node
// The Previews plugin's MCP server (docs/superpowers/specs/2026-10-28-previews-design.md): one
// tool, `preview`, that registers files of the thread's project with the daemon and stores one
// preview document in the plugin's storage. It runs under the THREAD's own key (DISPATCH_AUTH or
// DISPATCH_AUTH_FILE), so it can write into the thread's own project only; the daemon checks every
// path (inside the project, a known type, a regular file, size-capped) and serves it to the owner.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { KINDS, MAX_STEPS, checkArgs, expireSecret } from './kinds.mjs';

const PLUGIN = process.env.DISPATCH_PLUGIN || 'previews';
const API = (process.env.DISPATCH_API || `http://127.0.0.1:${process.env.DISPATCH_PORT || 3456}`).replace(/\/$/, '');
const CALL_TIMEOUT_MS = 15_000;
/** Past this many documents the oldest seen ones go (a plugin holds at most 2000). */
const PRUNE_AT = 1800;
const PRUNE_TO = 1500;
const DISABLED = 'The Drops plugin (id previews) is disabled in Dispatch: the owner can enable it in Settings → Plugins.';

function key() {
  if (process.env.DISPATCH_AUTH) return process.env.DISPATCH_AUTH.trim();
  if (process.env.DISPATCH_AUTH_FILE) { try { return fs.readFileSync(process.env.DISPATCH_AUTH_FILE, 'utf8').trim(); } catch { return null; } }
  return null;
}

async function call(method, route, body) {
  const k = key();
  if (!k) throw new Error('no Dispatch key in this process (DISPATCH_AUTH)');
  const res = await fetch(API + route, {
    method, signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    headers: { Authorization: `Bearer ${k}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text().catch(() => '');
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = data && typeof data === 'object' && (data.message || data.error) ? String(data.message || data.error) : `${res.status} ${res.statusText}`;
    const err = new Error(msg); err.status = res.status; throw err;
  }
  return data;
}

const TOOLS = [{
  name: 'preview',
  description:
    'Hand the user something to LOOK AT or COPY, wherever they are (phone or desktop, terminal mode ' +
    'or Pretty mode): it lands in their Drops list with a badge, and opens in the app. In terminal mode ' +
    'they cannot select text, so anything they must copy goes here, never only in your reply. ' +
    'Pass `paths` (files inside this project: png/jpg/gif/webp/svg images, pdf, html, md, txt, csv, json; ' +
    'up to 20) and/or `text` (up to 64 KB), a short `title` and a one-line `note`. Set `kind` for the look: ' +
    '`command` for anything the user must run (one per line in `text`, or `commands`; optional `cwd`), each ' +
    'with its own Copy button; `link` for a `url` (http/https) to open; `code` for a snippet (`language`); ' +
    '`secret` for a token or password (masked, removed after 24 hours; never repeat it in title or note); ' +
    '`steps` for a short procedure (`steps`: [{ text, command? }], max 30); `diff` for a unified diff; ' +
    '`table` for CSV `text` or one .csv/.json file. Without `kind`, images show as pictures, a URL as a link, ' +
    'markdown as a document and other text as text to copy.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: KINDS, description: 'The look of the drop. command: shell commands to run; link: a url; code: a snippet; secret: a token or password; steps: a procedure; diff: a unified diff; table: CSV or a .csv/.json file. Default: inferred.' },
      paths: { type: 'array', items: { type: 'string' }, description: 'Files inside the project working directory (relative or absolute).' },
      text: { type: 'string', description: 'A string for the user to copy. For command: one command per line. For table: CSV.' },
      commands: { type: 'array', items: { type: 'string' }, description: 'kind=command: the commands, one per item (instead of text).' },
      cwd: { type: 'string', description: 'kind=command: the folder the commands run in.' },
      url: { type: 'string', description: 'kind=link: an http:// or https:// address.' },
      language: { type: 'string', description: 'kind=code: the language name (ts, python, bash, ...).' },
      steps: { type: 'array', maxItems: MAX_STEPS, items: { type: 'object', properties: { text: { type: 'string' }, command: { type: 'string' } }, required: ['text'] }, description: 'kind=steps: the steps in order; a step with a command gets its own Copy.' },
      title: { type: 'string', description: 'A short name for the drop (default: the first file name, or a name for the kind).' },
      note: { type: 'string', description: 'One line of context: what this is and why it matters.' },
    },
  },
}];

const disabledIfGone = (e) => { if (e && e.status === 404 && /unknown plugin/i.test(String(e.message))) return new Error(DISABLED); return e; };

async function preview(args) {
  const a = args && typeof args === 'object' ? args : {};
  // The kind's checks (kinds.mjs): a plain message for each refusal, before anything is written.
  const { kind, text, paths, fields, defaultTitle } = checkArgs(a);
  const who = await call('GET', '/api/whoami');
  if (who.kind !== 'thread' || !who.sessionId) throw new Error('the preview tool runs inside a Dispatch thread only');
  // Paths are made absolute from this server's cwd (the thread's folder, a worktree perhaps), so the
  // daemon checks the file the thread meant. A refusal rolls back the references made before it.
  const files = [];
  for (const p of paths) {
    let f;
    try { f = await call('POST', `/api/plugins/${encodeURIComponent(PLUGIN)}/files`, { path: path.resolve(process.cwd(), p.trim()) }); }
    catch (e) {
      for (const made of files) { try { await call('DELETE', `/api/plugins/${encodeURIComponent(PLUGIN)}/files/${encodeURIComponent(made.fileId)}`); } catch { /* best effort */ } }
      throw disabledIfGone(e);
    }
    files.push({ fileId: f.fileId, name: f.name, mime: f.mime, size: f.size });
  }
  let terminalLabel = null;
  try { const t = await call('GET', `/api/terminals/${encodeURIComponent(who.terminalId)}`); terminalLabel = (t && t.label) || null; } catch { /* the label is a nicety */ }
  let sessionName = null;
  try {
    const s = await call('GET', '/api/sessions');
    const rows = Array.isArray(s) ? s : (s && s.sessions) || [];
    const row = rows.find((x) => x.id === who.sessionId);
    sessionName = row ? row.name : null;
  } catch { /* same */ }
  const id = randomUUID();
  const title = typeof a.title === 'string' && a.title.trim() ? a.title.trim().slice(0, 200) : files.length ? files[0].name : defaultTitle || 'Text';
  const note = typeof a.note === 'string' && a.note.trim() ? a.note.trim().slice(0, 1000) : null;
  const doc = { id, sessionId: who.sessionId, sessionName, terminalId: who.terminalId, terminalLabel, title, note, text, files, createdAt: new Date().toISOString(), seenAt: null };
  // No kind: no `kind` key, as before (the app infers the look).
  if (kind) Object.assign(doc, { kind }, fields);
  try { await call('PUT', `/api/plugins/${encodeURIComponent(PLUGIN)}/data/preview:${id}`, { value: doc }); }
  catch (e) { throw disabledIfGone(e); }
  void prune().catch(() => {});
  return { ok: true, id, files: files.map((f) => f.name) };
}

/**
 * Keep the store under the cap: past PRUNE_AT documents, the oldest seen previews go (their files with them).
 * And a secret's text goes 24 hours after it was posted (Drops, 2026-11-11). This runs at each post; the
 * app does the same when it loads the list. No timer.
 */
async function prune() {
  const list = await call('GET', `/api/plugins/${encodeURIComponent(PLUGIN)}/data?values=1`);
  const docs = ((list && list.docs) || []).filter((d) => d.key.startsWith('preview:') && d.value && typeof d.value === 'object');
  for (const d of docs) {
    const gone = expireSecret(d.value);
    if (!gone) continue;
    try { await call('PUT', `/api/plugins/${encodeURIComponent(PLUGIN)}/data/${encodeURIComponent(d.key)}`, { value: gone }); d.value = gone; } catch { /* the next post tries again */ }
  }
  if (docs.length <= PRUNE_AT) return;
  const seen = docs.filter((d) => d.value.seenAt).sort((a, b) => (a.value.createdAt < b.value.createdAt ? -1 : 1));
  for (const d of seen.slice(0, Math.max(0, docs.length - PRUNE_TO))) {
    try { await call('DELETE', `/api/plugins/${encodeURIComponent(PLUGIN)}/data/${encodeURIComponent(d.key)}`); } catch { continue; }
  }
}

async function callTool(name, args) {
  try {
    if (name !== 'preview') return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    const result = await preview(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Error: ${e && e.message ? e.message : String(e)}` }], isError: true };
  }
}

async function handle(req) {
  const { id, method, params } = req;
  const notification = id === undefined || id === null;
  try {
    switch (method) {
      case 'initialize': return { jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'dispatch-previews', version: '1.0.0' } } };
      case 'tools/list': return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
      case 'tools/call': return { jsonrpc: '2.0', id, result: await callTool(params && params.name, params && params.arguments) };
      case 'ping': return { jsonrpc: '2.0', id, result: {} };
      default:
        if (notification) return null;
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
    }
  } catch (e) {
    if (notification) return null;
    return { jsonrpc: '2.0', id, error: { code: -32603, message: e && e.message ? e.message : String(e) } };
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req;
  try { req = JSON.parse(trimmed); } catch { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n'); return; }
  void handle(req).then((res) => { if (res) process.stdout.write(JSON.stringify(res) + '\n'); }).catch(() => { /* never crash on one request */ });
});
rl.on('close', () => process.exit(0));
