#!/usr/bin/env node
// packages/core/src/os/os-tools-mcp.ts
// The `os-tools` MCP server a thread runs (stdio). It is a pipe, not a server of its own: each
// JSON-RPC line from the CLI goes to the daemon's loopback route POST /api/os-tools/mcp with the
// thread's own key (DISPATCH_AUTH, or the key file of DISPATCH_AUTH_FILE), and the daemon forwards it
// to POLYWOOD OS as the box (os/tools-proxy.ts). Each answer goes back as one line.
//
// Why stdio and not the CLIs' own HTTP MCP client: one bridge serves Claude Code, Codex, Grok and
// OpenCode the same way through the injection that already carries the per-thread key as an
// environment REFERENCE (mcp/injection.ts, authEnv). A native HTTP entry would need the key as a
// header value, which for Codex Pretty and OpenCode means a literal in a config.
//
// When OS is not reachable, the bridge stays up: `initialize` is answered locally, `tools/list` is
// empty, a tools call returns a plain error, and the bridge tries again in the background. When the
// list comes back it sends `notifications/tools/list_changed`, so the CLI picks the tools up again.
import * as readline from 'node:readline';
import { authHeaders } from '../overseer/agency-shared.js';

type Json = Record<string, any>;

export interface BridgeOptions {
  /** The daemon's address (DISPATCH_API). */
  api: string;
  write: (line: string) => void;
  fetchImpl?: typeof fetch;
  headers?: (url: string) => Record<string, string> | undefined;
  /** Background retry of a failed tools/list, in ms. 0: off (tests). */
  retryMs?: number;
}

const LOCAL_INIT = {
  protocolVersion: '2025-06-18',
  capabilities: { tools: { listChanged: true } },
  serverInfo: { name: 'os-tools', version: '1' },
  instructions: 'Company tools from POLYWOOD OS.',
};

/** The plain text of an error answer from the daemon or OS. */
function plainError(status: number, body: any): string {
  if (body && typeof body.message === 'string' && body.message) return body.message;
  if (status === 404) return 'Company tools are turned off for you in POLYWOOD OS.';
  if (status === 401) return 'POLYWOOD OS did not accept this box. Ask your administrator.';
  if (status === 403) return "This thread's Dispatch key is not valid for company tools. Start the thread again.";
  return `Company tools failed (HTTP ${status}).`;
}

export function createBridge(opts: BridgeOptions) {
  const url = `${opts.api.replace(/\/+$/, '')}/api/os-tools/mcp`;
  const doFetch = opts.fetchImpl ?? fetch;
  const headers = opts.headers ?? ((u: string) => authHeaders(u, {}));
  let protocolVersion: string | null = null;
  let listFailed = false;
  let retryTimer: NodeJS.Timeout | null = null;

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
        const r = await post({ jsonrpc: '2.0', id: '__os_tools_probe', method: 'tools/list', params: {} });
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
      return;
    }
    if (!isRequest) return; // a notification that failed: nothing to answer
    // Stay usable while OS is away: a local initialize, an empty tool list, a plain error for a call.
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: { ...LOCAL_INIT, protocolVersion: protocolVersion ?? LOCAL_INIT.protocolVersion } });
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
    stop() { if (retryTimer) clearTimeout(retryTimer); retryTimer = null; },
  };
}

function main(): void {
  const api = process.env.DISPATCH_API || `http://127.0.0.1:${process.env.DISPATCH_PORT || 3456}`;
  const bridge = createBridge({ api, write: (l) => process.stdout.write(l + '\n'), retryMs: 30_000 });
  const rl = readline.createInterface({ input: process.stdin });
  // Requests run concurrently (a slow tool must not hold a tools/list); each answer carries its id.
  rl.on('line', (l) => { void bridge.line(l); });
  rl.on('close', () => { bridge.stop(); process.exit(0); });
}

if (process.argv[1] && /os-tools-mcp\.(js|ts)$/.test(process.argv[1])) main();
