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

const PLUGIN = process.env.DISPATCH_PLUGIN || 'previews';
const API = (process.env.DISPATCH_API || `http://127.0.0.1:${process.env.DISPATCH_PORT || 3456}`).replace(/\/$/, '');
const MAX_FILES = 20;
const MAX_TEXT = 64 * 1024;
const CALL_TIMEOUT_MS = 15_000;
/** Past this many documents the oldest seen ones go (a plugin holds at most 2000). */
const PRUNE_AT = 1800;
const PRUNE_TO = 1500;
const DISABLED = 'The Previews plugin is disabled in Dispatch: the owner can enable it in Settings → Plugins.';

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
    'or Pretty mode): it lands in their Previews list with a badge, and opens in the app. Pass `paths` ' +
    '(files inside this project: png/jpg/gif/webp/svg images, pdf, html, md, txt, csv, json; up to 20) ' +
    'and/or `text` (a string they will copy: a URL, a command, a token, a snippet; up to 64 KB). ' +
    'Add a short `title` and a one-line `note` for context. Use it for screenshots, rendered pages, ' +
    'reports, HTML artifacts, and for any text the user must copy exactly; in terminal mode they cannot ' +
    'select text. Prefer this over describing a picture or dictating a long string.',
  inputSchema: {
    type: 'object',
    properties: {
      paths: { type: 'array', items: { type: 'string' }, description: 'Files inside the project working directory (relative or absolute).' },
      text: { type: 'string', description: 'A string for the user to copy.' },
      title: { type: 'string', description: 'A short name for the preview (default: the first file name, or "Text").' },
      note: { type: 'string', description: 'One line of context: what this is and why it matters.' },
    },
  },
}];

const disabledIfGone = (e) => { if (e && e.status === 404 && /unknown plugin/i.test(String(e.message))) return new Error(DISABLED); return e; };

async function preview(args) {
  const a = args && typeof args === 'object' ? args : {};
  const text = typeof a.text === 'string' && a.text.trim() ? a.text : null;
  if (text && text.length > MAX_TEXT) throw new Error('text too long (max 64 KB)');
  const paths = Array.isArray(a.paths) ? a.paths : [];
  if (paths.length > MAX_FILES) throw new Error(`too many files (max ${MAX_FILES})`);
  if (!text && paths.length === 0) throw new Error('a preview needs text or at least one path');
  for (const p of paths) if (typeof p !== 'string' || !p.trim()) throw new Error('each path must be a non-empty string');
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
  const title = typeof a.title === 'string' && a.title.trim() ? a.title.trim().slice(0, 200) : files.length ? files[0].name : 'Text';
  const note = typeof a.note === 'string' && a.note.trim() ? a.note.trim().slice(0, 1000) : null;
  const doc = { id, sessionId: who.sessionId, sessionName, terminalId: who.terminalId, terminalLabel, title, note, text, files, createdAt: new Date().toISOString(), seenAt: null };
  try { await call('PUT', `/api/plugins/${encodeURIComponent(PLUGIN)}/data/preview:${id}`, { value: doc }); }
  catch (e) { throw disabledIfGone(e); }
  void prune().catch(() => {});
  return { ok: true, id, files: files.map((f) => f.name) };
}

/** Keep the store under the cap: past PRUNE_AT documents, the oldest seen previews go (their files with them). */
async function prune() {
  const list = await call('GET', `/api/plugins/${encodeURIComponent(PLUGIN)}/data?values=1`);
  const docs = ((list && list.docs) || []).filter((d) => d.key.startsWith('preview:') && d.value && typeof d.value === 'object');
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
