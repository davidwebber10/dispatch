// packages/core/src/os/tools-proxy.ts
// The daemon side of "company tools" on a hosted box (box <-> OS contract, 2026-11-11).
//
// OS serves its tools at one MCP endpoint (`osTools.url`, stateless streamable-HTTP JSON-RPC). To call
// it, a request needs the box token, which must never reach a thread: not in an MCP config file, not
// in a thread's environment. So a thread talks to THIS loopback route with its own per-thread key
// (auth/principals.ts, `dtk_`), and the daemon forwards the JSON-RPC body to OS with the box token,
// the owner and the calling thread's id added. The key is valid only on this daemon, and this route
// answers only a loopback peer, so a leaked config would give nothing off the box.
//
//   thread CLI --stdio--> os-tools-mcp.js --HTTP+dtk_ key--> POST /api/os-tools/mcp --box token--> OS
//
// The owner's web page reads the state through GET /api/os/connections and asks OS for its tool list
// through GET /api/os/tools (no thread id: the page is not a thread).
import { fileURLToPath } from 'node:url';
import type { Request, Response, Router } from 'express';
import type { McpServerSpec } from '../mcp/injection.js';
import { keyRoute, ownerOnly, ownerOnlyStrict, policyRouter, type Rule } from '../auth/route-policy.js';
import { principalOf } from '../auth/request-principal.js';
import { isLoopbackAddress } from '../files/reveal.js';
import type { OsConnectionsProvider } from '../integrations/os-provider.js';

/** The MCP server name every thread gets the company tools under. */
export const OS_TOOLS_MCP_SERVER = 'os-tools';

export interface OsToolsProxyDeps {
  provider: OsConnectionsProvider;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** A tools call failed because OS was not reachable: tell the thread, in plain words (once per outage). */
  onUnreachable?: (terminalId: string, message: string) => void;
  /** The thread's systems filter (`x-dispatch-systems`), when a thread is limited to some systems. */
  systemsFor?: (terminalId: string) => string[] | null;
}

/** The plain sentence a person reads when the company tools cannot be reached. */
export const OS_UNREACHABLE_NOTICE =
  'Company tools are not reachable right now. Dispatch keeps trying in the background; the tools come back by themselves when POLYWOOD OS answers again.';

/** One JSON-RPC body from an SSE stream (`data:` lines), or the plain JSON body. Null when there is nothing. */
export function parseMcpBody(contentType: string | null, text: string): unknown {
  if (!text.trim()) return null;
  if (contentType && /text\/event-stream/i.test(contentType)) {
    const out: unknown[] = [];
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
      if (!data.trim()) continue;
      try { out.push(JSON.parse(data)); } catch { /* not a JSON event: skipped */ }
    }
    if (out.length === 0) return null;
    return out.length === 1 ? out[0] : out;
  }
  return JSON.parse(text);
}

export interface ForwardResult { status: number; body: unknown }

/** POST one JSON-RPC body to OS's MCP endpoint, as the box. Throws when OS cannot be reached. */
export async function forwardToOs(
  deps: Pick<OsToolsProxyDeps, 'provider' | 'fetchImpl' | 'timeoutMs'>,
  payload: unknown,
  extra: Record<string, string>,
): Promise<ForwardResult> {
  const url = deps.provider.osToolsUrl();
  if (!url) return { status: 404, body: { error: 'os_tools_disabled', message: 'Company tools are turned off for you in POLYWOOD OS.' } };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 60_000);
  try {
    const res = await (deps.fetchImpl ?? fetch)(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...deps.provider.boxHeaders(),
        ...extra,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await res.text();
    let body: unknown = null;
    try { body = parseMcpBody(res.headers.get('content-type'), text); } catch { body = { error: 'bad_response', message: `POLYWOOD OS answered ${res.status} with a body that is not JSON.` }; }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

const threadOnLoopback: Rule = (req) => (isLoopbackAddress(req.socket?.remoteAddress)
  ? { ok: true }
  : { ok: false, status: 403, error: 'out_of_scope', message: 'The company tools route answers only on this machine.' });

export function createOsToolsRouter(deps: OsToolsProxyDeps): Router {
  const router = policyRouter();
  const warned = new Set<string>();
  deps.provider.onChange((s) => { if (s.reachable) warned.clear(); });

  // A thread's call. Only a thread key, only from loopback. The owner and a credential-free caller
  // get 403: the route exists for threads, and a thread id comes only from the key.
  router.post('/os-tools/mcp', keyRoute({ thread: threadOnLoopback, roleRun: threadOnLoopback }), async (req: Request, res: Response) => {
    let terminalId: string;
    try {
      const p = principalOf(req);
      if (p.kind !== 'thread') return void res.status(403).json({ error: 'thread_only', message: 'Only a thread calls the company tools route.' });
      terminalId = p.terminalId;
    } catch {
      return void res.status(403).json({ error: 'thread_only', message: 'Only a thread calls the company tools route.' });
    }
    if (!isLoopbackAddress(req.socket?.remoteAddress)) return void res.status(403).json({ error: 'out_of_scope', message: 'The company tools route answers only on this machine.' });
    const systems = deps.systemsFor?.(terminalId) ?? null;
    const extra: Record<string, string> = { 'x-dispatch-thread-id': terminalId, ...(systems?.length ? { 'x-dispatch-systems': systems.join(',') } : {}) };
    const proto = req.headers['mcp-protocol-version'];
    if (typeof proto === 'string') extra['mcp-protocol-version'] = proto;
    try {
      const r = await forwardToOs(deps, req.body, extra);
      if (r.status >= 500) throw new Error(`POLYWOOD OS answered ${r.status}`);
      if (r.body === null) return void res.status(r.status === 200 ? 202 : r.status).end();
      res.status(r.status).json(r.body);
    } catch (err) {
      const msg = (err as Error)?.name === 'AbortError' ? 'no answer from POLYWOOD OS in time' : (err as Error)?.message || 'request failed';
      deps.provider.markUnreachable(msg);
      if (!warned.has(terminalId)) {
        warned.add(terminalId);
        try { deps.onUnreachable?.(terminalId, OS_UNREACHABLE_NOTICE); } catch { /* a notice is best effort */ }
      }
      res.status(502).json({ error: 'os_unreachable', message: OS_UNREACHABLE_NOTICE });
    }
  });

  // The page: what OS last said (profile, consent cards, reachability). No env, no tokens.
  router.get('/os/connections', ownerOnly, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(deps.provider.publicSnapshot());
  });

  // "Check again": ask OS now (after the person connected a system in OS).
  router.post('/os/connections/refresh', ownerOnlyStrict, async (_req, res) => {
    await deps.provider.refresh();
    res.setHeader('Cache-Control', 'no-store');
    res.json(deps.provider.publicSnapshot());
  });

  // The company tools as OS lists them for this person, for the Company connections panel.
  // OS sees no thread id here. 404: OS turned the tools off. 502: OS not reachable.
  router.get('/os/tools', ownerOnly, async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!deps.provider.osToolsUrl()) return void res.json({ enabled: false, reachable: deps.provider.snapshot().reachable, tools: [] });
    try {
      const init = await forwardToOs(deps, { jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dispatch-connections', version: '1' } } }, {});
      if (init.status === 404) return void res.json({ enabled: false, reachable: true, tools: [] });
      if (init.status >= 500) throw new Error(`POLYWOOD OS answered ${init.status}`);
      const list = await forwardToOs(deps, { jsonrpc: '2.0', id: 'list', method: 'tools/list', params: {} }, {});
      if (list.status >= 500) throw new Error(`POLYWOOD OS answered ${list.status}`);
      const tools = (list.body as { result?: { tools?: unknown[] } } | null)?.result?.tools;
      res.json({ enabled: true, reachable: true, tools: Array.isArray(tools) ? tools.map(publicTool) : [] });
    } catch (err) {
      deps.provider.markUnreachable((err as Error)?.message || 'request failed');
      res.json({ enabled: true, reachable: false, tools: [], error: OS_UNREACHABLE_NOTICE });
    }
  });

  return router;
}

/** A tool as the panel shows it: name, title, description, its system and whether it writes. */
function publicTool(t: unknown): { name: string; title: string | null; description: string | null; system: string | null; readOnly: boolean | null } {
  const o = (t && typeof t === 'object' ? t : {}) as Record<string, any>;
  const name = typeof o.name === 'string' ? o.name : '';
  const meta = o._meta && typeof o._meta === 'object' ? o._meta : {};
  const system = typeof meta.system === 'string' ? meta.system
    : typeof o.annotations?.system === 'string' ? o.annotations.system
      : /^([a-z0-9]+)[_.]/i.exec(name)?.[1] ?? null;
  return {
    name,
    title: typeof o.title === 'string' ? o.title : typeof o.annotations?.title === 'string' ? o.annotations.title : null,
    description: typeof o.description === 'string' ? o.description : null,
    system,
    readOnly: typeof o.annotations?.readOnlyHint === 'boolean' ? o.annotations.readOnlyHint : null,
  };
}

/**
 * The `os-tools` MCP server spec for a thread: the stdio bridge (os-tools-mcp.js) with the daemon's
 * loopback address. `authEnv`: the injection gives it the thread key as an environment REFERENCE
 * (mcp/injection.ts), so no file holds a key, and the box token is in none of it.
 */
export function osToolsServerSpec(daemonApi: string): McpServerSpec {
  const bridge = fileURLToPath(new URL('./os-tools-mcp.js', import.meta.url));
  return { name: OS_TOOLS_MCP_SERVER, command: 'node', args: [bridge], env: { DISPATCH_API: daemonApi }, authEnv: true };
}
