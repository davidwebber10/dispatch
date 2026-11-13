#!/usr/bin/env node
// packages/core/src/os/os-mcp-bridge.ts
// The stdio form of ONE company-system MCP server (os/os-servers.ts). A harness that can take a
// loopback HTTP entry with the thread key in a header (Claude Code, the Codex CLI, Codex Pretty,
// OpenCode) reaches the daemon route directly and runs no process; a harness that cannot (Grok, the
// Codex CLI view whose key is a file) runs this bridge, one per system.
//
// It is a pipe, not a server of its own: each JSON-RPC line from the CLI goes to the daemon's
// loopback route POST /api/os/mcp/<system> (DISPATCH_OS_SYSTEM) with the thread's own key
// (DISPATCH_AUTH, or the key file of DISPATCH_AUTH_FILE). The route renames the tools and forwards to
// POLYWOOD OS as the box (os/tools-proxy.ts). Each answer goes back as one line.
//
// When the daemon is not reachable, the bridge stays up: `initialize` is answered locally,
// `tools/list` is empty, a tools call returns a plain error, and the bridge tries again in the
// background. When the list comes back it sends `notifications/tools/list_changed`.
//
// After `initialize` it also opens the route's event stream (GET, Accept: text/event-stream) and passes
// each notification on it to the CLI: `list_changed` when the person connected this system mid-thread.
import * as readline from 'node:readline';
import { PLATFORM_NAME } from './platform-name.js';
import { authHeaders } from '../overseer/agency-shared.js';
import { serverNameFor } from './os-servers.js';

type Json = Record<string, any>;

export interface BridgeOptions {
  /** The daemon's address (DISPATCH_API). */
  api: string;
  /** The OS system this bridge serves (DISPATCH_OS_SYSTEM). */
  system: string;
  write: (line: string) => void;
  fetchImpl?: typeof fetch;
  headers?: (url: string) => Record<string, string> | undefined;
  /** Background retry of a failed tools/list, in ms. 0: off (tests). */
  retryMs?: number;
  /**
   * Open the route's event stream after `initialize` and pass each notification from it to the CLI
   * (`notifications/tools/list_changed` when the person connected the system). Off by default (tests).
   */
  stream?: boolean;
  /** Wait before the event stream is opened again after it dropped, in ms (default 5 s). */
  streamRetryMs?: number;
}

/** The JSON-RPC messages of a text/event-stream chunk sequence: complete events only; the rest is kept. */
export function takeSseMessages(buffer: string): { messages: unknown[]; rest: string } {
  const text = buffer.replace(/\r\n/g, '\n');
  const blocks = text.split('\n\n');
  const rest = blocks.pop() ?? '';
  const messages: unknown[] = [];
  for (const block of blocks) {
    const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
    if (!data.trim()) continue;
    try { messages.push(JSON.parse(data)); } catch { /* not JSON: skipped */ }
  }
  return { messages, rest };
}

const localInit = (system: string) => ({
  protocolVersion: '2025-06-18',
  capabilities: { tools: { listChanged: true } },
  serverInfo: { name: serverNameFor(system), version: '1' },
  instructions: `Company tools from ${PLATFORM_NAME}.`,
});

/** The plain text of an error answer from the daemon or OS. */
function plainError(status: number, body: any): string {
  if (body && typeof body.message === 'string' && body.message) return body.message;
  if (status === 404) return `Company tools are turned off for you in ${PLATFORM_NAME}.`;
  if (status === 401) return `${PLATFORM_NAME} did not accept this box. Ask your administrator.`;
  if (status === 403) return "This thread's Dispatch key is not valid for company tools. Start the thread again.";
  return `Company tools failed (HTTP ${status}).`;
}

export function createBridge(opts: BridgeOptions) {
  const url = `${opts.api.replace(/\/+$/, '')}/api/os/mcp/${encodeURIComponent(opts.system)}`;
  const LOCAL_INIT = localInit(opts.system);
  const doFetch = opts.fetchImpl ?? fetch;
  const headers = opts.headers ?? ((u: string) => authHeaders(u, {}));
  let protocolVersion: string | null = null;
  let listFailed = false;
  let retryTimer: NodeJS.Timeout | null = null;
  let stopped = false;
  let streamAbort: AbortController | null = null;
  let streamTimer: NodeJS.Timeout | null = null;
  let streamOpened = 0;

  /**
   * The daemon's event stream for this system: each notification on it goes to the CLI as one line.
   * When it drops (a daemon restart), it opens again; the CLI then gets one list_changed, because a
   * change may have happened while it was closed. A daemon without the stream (405) is left alone.
   */
  async function openStream(): Promise<void> {
    if (!opts.stream || stopped || streamAbort) return;
    const ac = new AbortController();
    streamAbort = ac;
    let reopen = true;
    try {
      const res = await doFetch(url, {
        method: 'GET',
        headers: { accept: 'text/event-stream', ...(protocolVersion ? { 'mcp-protocol-version': protocolVersion } : {}), ...(headers(url) ?? {}) },
        signal: ac.signal,
      });
      if (res.status === 405 || res.status === 404) { reopen = false; return; }
      if (res.status >= 300 || !res.body) return;
      if (streamOpened++ > 0) send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
      const decoder = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        const got = takeSseMessages(buf + decoder.decode(chunk, { stream: true }));
        buf = got.rest;
        for (const m of got.messages) {
          if (m && typeof m === 'object' && typeof (m as Json).method === 'string' && (m as Json).id === undefined) send(m);
        }
      }
    } catch { /* dropped: opened again below */ } finally {
      if (streamAbort === ac) streamAbort = null;
      if (reopen && !stopped && opts.stream) {
        streamTimer = setTimeout(() => { streamTimer = null; void openStream(); }, opts.streamRetryMs ?? 5_000);
        streamTimer.unref?.();
      }
    }
  }

  async function post(msg: Json): Promise<{ status: number; body: any }> {
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(protocolVersion ? { 'mcp-protocol-version': protocolVersion } : {}), ...(headers(url) ?? {}) },
      body: JSON.stringify(msg),
    });
    const text = await res.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { message: text.slice(0, 300) }; }
    return { status: res.status, body };
  }

  const send = (m: unknown) => opts.write(JSON.stringify(m));
  const answers = (body: any): Json[] => (Array.isArray(body) ? body : body && typeof body === 'object' && 'jsonrpc' in body ? [body] : []);

  function scheduleListRetry(): void {
    if (!opts.retryMs || retryTimer) return;
    retryTimer = setTimeout(async () => {
      retryTimer = null;
      try {
        const r = await post({ jsonrpc: '2.0', id: '__os_probe', method: 'tools/list', params: {} });
        if (r.status < 300 && answers(r.body).some((a) => a.result)) {
          listFailed = false;
          send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
          return;
        }
      } catch { /* still down */ }
      scheduleListRetry();
    }, opts.retryMs);
    retryTimer.unref?.();
  }

  async function handle(msg: Json): Promise<void> {
    const isRequest = msg && msg.id !== undefined && msg.id !== null && typeof msg.method === 'string';
    if (msg?.method === 'initialize' && typeof msg.params?.protocolVersion === 'string') protocolVersion = msg.params.protocolVersion;
    let r: { status: number; body: any };
    try {
      r = await post(msg);
    } catch (err) {
      r = { status: 502, body: { message: `The Dispatch daemon did not answer: ${(err as Error)?.message ?? err}` } };
    }
    if (r.status < 300) {
      const out = answers(r.body);
      for (const a of out) send(a);
      if (msg?.method === 'tools/list' && out.some((a) => a.result)) listFailed = false;
      if (msg?.method === 'initialize') void openStream();
      return;
    }
    if (!isRequest) return; // a notification that failed: nothing to answer
    // Stay usable while OS is away: a local initialize, an empty tool list, a plain error for a call.
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: { ...LOCAL_INIT, protocolVersion: protocolVersion ?? LOCAL_INIT.protocolVersion } });
      void openStream();
      return;
    }
    if (msg.method === 'tools/list') {
      listFailed = true;
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } });
      scheduleListRetry();
      return;
    }
    if (msg.method === 'tools/call') {
      const code = r.status === 404 ? 'not_permitted' : r.status === 502 || r.status >= 500 ? 'os_unreachable' : 'tool_failed';
      send({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: code, message: plainError(r.status, r.body) }) }] } });
      if (r.status >= 500) scheduleListRetry();
      return;
    }
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: plainError(r.status, r.body) } });
  }

  return {
    handle,
    /** One line from the CLI. A line that is not JSON gets a parse error (JSON-RPC -32700). */
    async line(raw: string): Promise<void> {
      if (!raw.trim()) return;
      let msg: any;
      try { msg = JSON.parse(raw); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
      if (Array.isArray(msg)) { for (const m of msg) await handle(m); return; }
      await handle(msg);
    },
    get listFailed() { return listFailed; },
    stop() {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      if (streamTimer) clearTimeout(streamTimer);
      streamTimer = null;
      streamAbort?.abort();
      streamAbort = null;
    },
  };
}

function main(): void {
  const api = process.env.DISPATCH_API || `http://127.0.0.1:${process.env.DISPATCH_PORT || 3456}`;
  const system = process.env.DISPATCH_OS_SYSTEM || '';
  if (!system) { process.stderr.write('DISPATCH_OS_SYSTEM is not set\n'); process.exit(2); }
  const bridge = createBridge({ api, system, write: (l) => process.stdout.write(l + '\n'), retryMs: 30_000, stream: true });
  const rl = readline.createInterface({ input: process.stdin });
  // Requests run concurrently (a slow tool must not hold a tools/list); each answer carries its id.
  rl.on('line', (l) => { void bridge.line(l); });
  rl.on('close', () => { bridge.stop(); process.exit(0); });
}

if (process.argv[1] && /os-mcp-bridge\.(js|ts)$/.test(process.argv[1])) main();
