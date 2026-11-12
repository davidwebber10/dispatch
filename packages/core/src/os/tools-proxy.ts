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
// A thread sees each company system as its own MCP server (os/os-servers.ts): one route per system,
//
//   thread CLI --HTTP+dtk_ key (or the stdio bridge os-mcp-bridge.js)--> POST /api/os/mcp/<system>
//              --box token, owner, thread id, x-dispatch-systems: <system>, real tool name--> OS
//
// The route renames the tools (`acumatica_get_customer` <-> `get_customer`) so OS needs no change.
// OsToolCatalog keeps OS's tool list (one fetch per change) to decide which servers a spawn gets and
// to answer tools/list while OS is away.
//
// The owner's web page reads the state through GET /api/os/connections and asks OS for its tool list
// through GET /api/os/tools (no thread id: the page is not a thread).
//
// Live tool changes (2026-11-12). A system the person may use but has not connected has ONE gateway
// tool, `<system>_connect`; once connected, its real tools. A running thread learns of the change by
// MCP `notifications/tools/list_changed`, sent on the streamable-HTTP GET event stream of the route
// (the stdio bridge opens that stream for its harness). The daemon learns of it from the OS poll
// (catalog refresh on a changed answer), from a fast re-check after a `connect` call (every 5 s for
// 5 minutes, that system only), from `POST /api/os/connections/refresh` (the platform's signal), and
// from the `refresh` tool of the `connections` server. A system that appears mid-thread gets no new
// server in that thread: servers are fixed at spawn, so it reaches new threads only.
import { fileURLToPath } from 'node:url';
import { PLATFORM_NAME } from './platform-name.js';
import type { Request, Response, Router } from 'express';
import type { McpServerSpec } from '../mcp/injection.js';
import { boxCapabilities } from '../platform/capabilities.js';
import { keyRoute, ownerOnly, ownerOnlyStrict, policyRouter, type Rule } from '../auth/route-policy.js';
import { principalOf, scopeOf } from '../auth/request-principal.js';
import { isLoopbackAddress } from '../files/reveal.js';
import type { OsConnectionsProvider } from '../integrations/os-provider.js';
import { OS_SELF_SYSTEM, gatewayInfo, instructionsHome, isSystemId, localToolName, osServerSpecs, realToolName, renameTool, rewriteInstructions, serverNameFor, setGatewayInfo, toolSystem } from './os-servers.js';

export interface OsToolsProxyDeps {
  provider: OsConnectionsProvider;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** A tools call failed because OS was not reachable: tell the thread, in plain words (once per outage). */
  onUnreachable?: (terminalId: string, message: string) => void;
  /** The thread's systems filter (`x-dispatch-systems`), when a thread is limited to some systems. */
  systemsFor?: (terminalId: string) => string[] | null;
  /** OS's tool list (which servers exist, and tools/list while OS is away). */
  catalog?: OsToolCatalog;
}

/** The gateway's one tool of a system the person has not connected yet (`<system>_connect`, thread name `connect`). */
export const CONNECT_TOOL = 'connect';
/** The daemon's own tool on the `connections` server: check the connections again now. */
export const REFRESH_TOOL = 'refresh';
export const REFRESH_TOOL_DEF = Object.freeze({
  name: REFRESH_TOOL,
  title: 'Check connections again',
  description: 'Check the company connections again now, after the person connected a system (for example from a Connect card). '
    + 'Answers which systems changed and which tools they have now.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { title: 'Check connections again', readOnlyHint: true },
});

/**
 * Harnesses that load a server's new tool list into a RUNNING session after list_changed, measured
 * 2026-11-12 with a stub model (docs/hosted.md "Live tool changes"): Claude Code 2.1.322 (HTTP and
 * stdio) and OpenCode 1.18.34 (HTTP and stdio; the image's 1.19.5 not measured). Codex 0.167.0 does
 * not (not on the next turn either, not after `config/mcpServer/reload`); Grok was not measured.
 */
export const LIVE_TOOLS_HARNESSES: readonly string[] = ['claude-code', 'opencode'];

/**
 * The sentence added to a `connect` call's result: what happens next, and what to do when the tools do
 * not come. `live`: whether the thread's harness loads new tools mid-session (null: not known).
 */
export function connectFollowUp(system: string, live: boolean | null = null): string {
  const server = serverNameFor(system);
  if (live === false) {
    return `This thread cannot load new tools while it runs. When the person has connected ${server}, ask them to send the request again in a new thread: `
      + `a new thread gets the ${server} tools.`;
  }
  return `When the person has connected ${server}, its tools reach this thread by themselves within a few seconds; then use them for the request. `
    + `If they do not appear, call the \`${REFRESH_TOOL}\` tool of the \`${serverNameFor(OS_SELF_SYSTEM)}\` server. `
    + 'If they still do not appear, ask the person to send the request again in a new thread.';
}

/** The plain sentence a person reads when the company tools cannot be reached. */
export const OS_UNREACHABLE_NOTICE =
  `Company tools are not reachable right now. Dispatch keeps trying in the background; the tools come back by themselves when ${PLATFORM_NAME} answers again.`;

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
  if (!url) return { status: 404, body: { error: 'os_tools_disabled', message: `Company tools are turned off for you in ${PLATFORM_NAME}.` } };
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
    try { body = parseMcpBody(res.headers.get('content-type'), text); } catch { body = { error: 'bad_response', message: `${PLATFORM_NAME} answered ${res.status} with a body that is not JSON.` }; }
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

  // A thread's call to one company system. Only a thread key, only from loopback. The owner and a
  // credential-free caller get 403: the route exists for threads, and a thread id comes only from the key.
  const threadOnly = (req: Request, res: Response): string | null => {
    try {
      const p = principalOf(req);
      if (p.kind === 'thread' && isLoopbackAddress(req.socket?.remoteAddress)) return p.terminalId;
    } catch { /* below */ }
    res.status(403).json({ error: 'thread_only', message: 'Only a thread on this machine calls the company tools route.' });
    return null;
  };
  router.post('/os/mcp/:system', keyRoute({ thread: threadOnLoopback, roleRun: threadOnLoopback }), async (req: Request, res: Response) => {
    const terminalId = threadOnly(req, res);
    if (!terminalId) return;
    const system = String(req.params.system ?? '');
    if (!isSystemId(system)) return void res.status(404).json({ error: 'unknown_system', message: 'No such company system.' });
    const limit = deps.systemsFor?.(terminalId) ?? null;
    const allowed = system === OS_SELF_SYSTEM || !limit || limit.includes(system);
    const proto = typeof req.headers['mcp-protocol-version'] === 'string' ? req.headers['mcp-protocol-version'] : null;
    let harness: string | null = null;
    try { harness = scopeOf(req).caller(terminalId)?.type ?? null; } catch { harness = null; }
    const ctx: CallCtx = { terminalId, system, allowed, proto, harness };
    const body = req.body;
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((m) => handleOne(ctx, m)))).filter((x): x is Json => x !== null);
      return void (out.length ? res.json(out) : res.status(202).end());
    }
    const one = await handleOne(ctx, body);
    if (one === null) return void res.status(202).end();
    res.json(one);
  });
  // Streamable HTTP, server-to-client: the GET event stream carries `notifications/tools/list_changed`
  // when this system's tools change (the person connected it). No session to end on this route.
  const streams = new Map<string, Set<{ terminalId: string; res: Response }>>();
  const LIST_CHANGED = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n\n`;
  deps.catalog?.onToolsChanged((systems) => {
    for (const system of systems) {
      for (const s of streams.get(system) ?? []) {
        const limit = deps.systemsFor?.(s.terminalId) ?? null;
        if (system !== OS_SELF_SYSTEM && limit && !limit.includes(system)) continue;
        try { s.res.write(LIST_CHANGED); } catch { /* a closed stream is removed on close */ }
      }
    }
  });
  const noStream = (_req: Request, res: Response) => { res.setHeader('Allow', 'POST, GET'); res.status(405).json({ error: 'method_not_allowed', message: 'POST, or GET with Accept: text/event-stream.' }); };
  router.get('/os/mcp/:system', keyRoute({ thread: threadOnLoopback, roleRun: threadOnLoopback }), (req: Request, res: Response) => {
    if (!/text\/event-stream/i.test(String(req.headers.accept ?? ''))) return noStream(req, res);
    const terminalId = threadOnly(req, res);
    if (!terminalId) return;
    const system = String(req.params.system ?? '');
    if (!isSystemId(system)) return void res.status(404).json({ error: 'unknown_system', message: 'No such company system.' });
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write(': open\n\n');
    const entry = { terminalId, res };
    const set = streams.get(system) ?? new Set();
    set.add(entry);
    streams.set(system, set);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 25_000);
    ping.unref?.();
    req.on('close', () => {
      clearInterval(ping);
      set.delete(entry);
      if (set.size === 0) streams.delete(system);
    });
  });
  router.delete('/os/mcp/:system', keyRoute({ thread: threadOnLoopback, roleRun: threadOnLoopback }), noStream);

  type Json = Record<string, any>;
  interface CallCtx { terminalId: string; system: string; allowed: boolean; proto: string | null; harness: string | null }
  const liveOf = (ctx: CallCtx): boolean | null => (ctx.harness ? LIVE_TOOLS_HARNESSES.includes(ctx.harness) : null);

  /** OS could not be reached: flag it, and tell the thread once (per outage) in plain words. */
  const unreachable = (ctx: CallCtx, err: unknown) => {
    const msg = (err as Error)?.name === 'AbortError' ? `no answer from ${PLATFORM_NAME} in time` : (err as Error)?.message || 'request failed';
    deps.provider.markUnreachable(msg);
    if (!warned.has(ctx.terminalId)) {
      warned.add(ctx.terminalId);
      try { deps.onUnreachable?.(ctx.terminalId, OS_UNREACHABLE_NOTICE); } catch { /* a notice is best effort */ }
    }
  };
  const toOs = async (ctx: CallCtx, payload: unknown): Promise<ForwardResult> => {
    const extra: Record<string, string> = { 'x-dispatch-thread-id': ctx.terminalId, 'x-dispatch-systems': ctx.system };
    if (ctx.proto) extra['mcp-protocol-version'] = ctx.proto;
    const r = await forwardToOs(deps, payload, extra);
    if (r.status >= 500) throw new Error(`${PLATFORM_NAME} answered ${r.status}`);
    return r;
  };
  const answerOf = (body: unknown, id: unknown): Json | null => {
    if (body && typeof body === 'object' && !Array.isArray(body)) return 'jsonrpc' in body ? (body as Json) : null;
    const list = Array.isArray(body) ? body : [];
    return (list.find((a) => a && typeof a === 'object' && (a as Json).id === id) as Json | undefined) ?? null;
  };
  const errorResult = (id: unknown, code: string, message: string): Json =>
    ({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: code, message }) }] } });

  /** One JSON-RPC message. Null: a notification (nothing to answer). */
  async function handleOne(ctx: CallCtx, msg: Json): Promise<Json | null> {
    if (!msg || typeof msg !== 'object') return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } };
    const id = msg.id;
    if (id === undefined || id === null) return null;
    const method = typeof msg.method === 'string' ? msg.method : '';
    const server = serverNameFor(ctx.system);
    if (method === 'initialize') {
      const local = { jsonrpc: '2.0', id, result: { protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '2025-06-18', capabilities: { tools: { listChanged: true } }, serverInfo: { name: server, version: '1' }, instructions: `Company tools from ${PLATFORM_NAME}.` } };
      if (!deps.provider.osToolsUrl()) return local;
      // The gateway's instructions ride ONE server (os-servers.ts instructionsHome: `data`, else
      // `connections`), with the tool names as a thread sees them; every other server gets one line.
      const systems = deps.catalog?.loaded ? deps.catalog.systems() : [];
      const home = instructionsHome(systems.length ? systems : [OS_SELF_SYSTEM]) === ctx.system;
      const withText = (text: unknown) => (home && typeof text === 'string' && text.trim()
        ? rewriteInstructions(text, deps.catalog?.toolNames() ?? gatewayInfo().tools)
        : local.result.instructions);
      try {
        const a = answerOf((await toOs(ctx, msg)).body, id);
        // `tools.listChanged` is the box's promise, whatever the gateway declares: a harness subscribes
        // to list_changed only when the server declares it (measured with Claude Code 2.1.322).
        if (a?.result) {
          const caps = a.result.capabilities && typeof a.result.capabilities === 'object' ? a.result.capabilities : {};
          const tools = caps.tools && typeof caps.tools === 'object' ? caps.tools : {};
          return { ...a, result: { ...a.result, capabilities: { ...caps, tools: { ...tools, listChanged: true } }, serverInfo: { name: server, version: String(a.result.serverInfo?.version ?? '1') }, instructions: withText(a.result.instructions) } };
        }
      } catch (err) { unreachable(ctx, err); }
      return { ...local, result: { ...local.result, instructions: withText(gatewayInfo().instructions) } };
    }
    if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
    if (method === 'resources/list') return { jsonrpc: '2.0', id, result: { resources: [] } };
    if (method === 'resources/templates/list') return { jsonrpc: '2.0', id, result: { resourceTemplates: [] } };
    if (method === 'prompts/list') return { jsonrpc: '2.0', id, result: { prompts: [] } };
    if (method === 'tools/list') {
      if (!ctx.allowed || !deps.provider.osToolsUrl()) return { jsonrpc: '2.0', id, result: { tools: [] } };
      // The `connections` server also lists the daemon's own `refresh` tool (unless the gateway has one).
      const withLocal = (tools: Json[]): Json[] => (ctx.system === OS_SELF_SYSTEM && deps.catalog && !tools.some((t) => t.name === REFRESH_TOOL)
        ? [...tools, { ...REFRESH_TOOL_DEF }]
        : tools);
      try {
        const r = await toOs(ctx, msg);
        const a = answerOf(r.body, id);
        const tools: unknown[] = Array.isArray(a?.result?.tools) ? a!.result.tools : [];
        if (r.status < 300 && a?.result) {
          return { jsonrpc: '2.0', id, result: { tools: withLocal(tools.filter((t) => toolSystem(t, deps.catalog?.knownSystems() ?? []) === ctx.system).map((t) => renameTool(ctx.system, t as Json))) } };
        }
        if (r.status === 404) return { jsonrpc: '2.0', id, result: { tools: [] } };
      } catch (err) { unreachable(ctx, err); }
      // OS away: the last list this box saw, so a thread that starts now still has its tools.
      return { jsonrpc: '2.0', id, result: { tools: withLocal((deps.catalog?.tools(ctx.system) ?? []).map((t) => renameTool(ctx.system, t))) } };
    }
    if (method === 'tools/call') {
      const local = typeof msg.params?.name === 'string' ? msg.params.name : '';
      if (!ctx.allowed) return errorResult(id, 'not_permitted', 'This thread may not use this company system.');
      if (!deps.provider.osToolsUrl()) return errorResult(id, 'not_permitted', `Company tools are turned off for you in ${PLATFORM_NAME}.`);
      const realNames = deps.catalog?.realNames(ctx.system) ?? [];
      if (ctx.system === OS_SELF_SYSTEM && local === REFRESH_TOOL && deps.catalog && !realNames.some((n) => localToolName(ctx.system, n) === REFRESH_TOOL)) {
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: await refreshNow(deps.provider, deps.catalog, liveOf(ctx)) }] } };
      }
      const real = realToolName(ctx.system, local, realNames);
      try {
        const r = await toOs(ctx, { ...msg, params: { ...(msg.params ?? {}), name: real } });
        const a = answerOf(r.body, id);
        if (a && local === CONNECT_TOOL && real === `${ctx.system}_${CONNECT_TOOL}`) {
          // The person gets a Connect card now: watch this system closely for a while, and tell the agent what comes next.
          deps.catalog?.watchAfterConnect(ctx.system);
          if (a.result && Array.isArray(a.result.content)) {
            return { ...a, result: { ...a.result, content: [...a.result.content, { type: 'text', text: connectFollowUp(ctx.system, liveOf(ctx)) }] } };
          }
        }
        if (a) return a;
        return errorResult(id, r.status === 404 ? 'not_permitted' : 'tool_failed', (r.body as Json | null)?.message ?? `Company tools failed (HTTP ${r.status}).`);
      } catch (err) {
        unreachable(ctx, err);
        return errorResult(id, 'os_unreachable', OS_UNREACHABLE_NOTICE);
      }
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }

  // The page: what OS last said (profile, consent cards, reachability). No env, no tokens.
  router.get('/os/connections', ownerOnly, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ...deps.provider.publicSnapshot(), capabilities: boxCapabilities() });
  });

  // "Check again": ask OS now (after the person connected a system in OS). The platform's signal too: a
  // changed tool list reaches every running thread of this box (list_changed on its event stream).
  router.post('/os/connections/refresh', ownerOnlyStrict, async (_req, res) => {
    await deps.provider.refresh();
    await deps.catalog?.refresh();
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
      if (init.status >= 500) throw new Error(`${PLATFORM_NAME} answered ${init.status}`);
      const list = await forwardToOs(deps, { jsonrpc: '2.0', id: 'list', method: 'tools/list', params: {} }, {});
      if (list.status >= 500) throw new Error(`${PLATFORM_NAME} answered ${list.status}`);
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
function publicTool(t: unknown): { name: string; server: string | null; tool: string; title: string | null; description: string | null; system: string | null; readOnly: boolean | null } {
  const o = (t && typeof t === 'object' ? t : {}) as Record<string, any>;
  const name = typeof o.name === 'string' ? o.name : '';
  const system = toolSystem(o);
  return {
    name,
    server: system ? serverNameFor(system) : null,
    tool: system ? localToolName(system, name) : name,
    title: typeof o.title === 'string' ? o.title : typeof o.annotations?.title === 'string' ? o.annotations.title : null,
    description: typeof o.description === 'string' ? o.description : null,
    system,
    readOnly: typeof o.annotations?.readOnlyHint === 'boolean' ? o.annotations.readOnlyHint : null,
  };
}

/**
 * The `refresh` tool of the `connections` server: ask OS again now, and say in plain words what changed.
 * A changed system's tools reach the thread through list_changed (the catalog's change event).
 */
export async function refreshNow(provider: OsConnectionsProvider, catalog: OsToolCatalog, live: boolean | null = null): Promise<string> {
  await provider.refresh();
  const changed = (await catalog.refresh()).filter((s) => s !== OS_SELF_SYSTEM);
  const lines: string[] = ['Checked the company connections again.'];
  const describe = (s: string) => {
    const names = catalog.realNames(s).map((n) => localToolName(s, n));
    return names.length === 1 && names[0] === CONNECT_TOOL
      ? `${serverNameFor(s)} (not connected yet: call \`${serverNameFor(s)}.${CONNECT_TOOL}\`)`
      : `${serverNameFor(s)} (tools: ${names.join(', ') || 'none'})`;
  };
  if (changed.length) lines.push(`Changed now: ${changed.map(describe).join('; ')}.`);
  else lines.push('Nothing changed since the last check.');
  const waiting = catalog.systems().filter((s) => s !== OS_SELF_SYSTEM && !changed.includes(s) && catalog.realNames(s).every((n) => localToolName(s, n) === CONNECT_TOOL));
  if (waiting.length) lines.push(`Not connected yet: ${waiting.map(serverNameFor).join(', ')}.`);
  if (changed.length && live === false) lines.push('This thread cannot load the new tools while it runs: ask the person to send the request again in a new thread.');
  else if (changed.length) lines.push('If the new tools are not in your tool list, ask the person to send the request again in a new thread: this thread cannot load them.');
  return lines.join('\n');
}

/** The stdio bridge script (the per-system server for a harness that takes no loopback HTTP entry). */
export const OS_BRIDGE_PATH = fileURLToPath(new URL('./os-mcp-bridge.js', import.meta.url));

/**
 * OS's tool list, kept by the box: which systems have a tool for this person (one server each) and,
 * while OS is away, what tools/list answers. Fetched with no thread id and no systems filter, once
 * when OS's answer changes and again when older than `ttlMs` (in the background of a spawn).
 */
export class OsToolCatalog {
  private bySystem = new Map<string, Array<Record<string, unknown>>>();
  private loadedAt: number | null = null;
  private inFlight: Promise<string[]> | null = null;
  private readonly ttlMs: number;
  private readonly connectCheckMs: number;
  private readonly connectWindowMs: number;
  private readonly changeListeners = new Set<(systems: string[]) => void>();
  private readonly watches = new Map<string, { timer: NodeJS.Timeout; until: number; busy: boolean }>();
  constructor(private readonly deps: Pick<OsToolsProxyDeps, 'provider' | 'fetchImpl' | 'timeoutMs'> & {
    ttlMs?: number;
    /** After a `connect` call: how often that system is checked (default 5 s) and for how long (default 5 min). */
    connectCheckMs?: number;
    connectWindowMs?: number;
  }) {
    this.ttlMs = deps.ttlMs ?? 5 * 60_000;
    this.connectCheckMs = deps.connectCheckMs ?? 5_000;
    this.connectWindowMs = deps.connectWindowMs ?? 5 * 60_000;
  }

  /** Called with the systems whose tool set changed (never on a refresh that changed nothing, never on the first load). */
  onToolsChanged(fn: (systems: string[]) => void): () => void {
    this.changeListeners.add(fn);
    return () => { this.changeListeners.delete(fn); };
  }

  private emit(systems: string[]): void {
    if (systems.length === 0) return;
    for (const fn of this.changeListeners) { try { fn(systems); } catch { /* a listener never breaks a refresh */ } }
  }

  /**
   * A `connect` call returned for `system`: check that system now and then every `connectCheckMs` for
   * `connectWindowMs`, so its tools reach the thread seconds after the person connects it. The watch
   * ends at the first change. A second call during the window only extends it.
   */
  watchAfterConnect(system: string): void {
    if (!isSystemId(system)) return;
    const until = Date.now() + this.connectWindowMs;
    const have = this.watches.get(system);
    if (have) { have.until = until; return; }
    const tick = async () => {
      const w = this.watches.get(system);
      if (!w || w.busy) return;
      if (Date.now() > w.until) { this.stopWatch(system); return; }
      w.busy = true;
      try { if (await this.refreshSystem(system)) this.stopWatch(system); } finally { w.busy = false; }
    };
    const timer = setInterval(() => { void tick(); }, this.connectCheckMs);
    timer.unref?.();
    this.watches.set(system, { timer, until, busy: false });
    void tick();
  }

  /** The systems watched after a `connect` call (tests, diagnostics). */
  watching(): string[] { return [...this.watches.keys()]; }

  private stopWatch(system: string): void {
    const w = this.watches.get(system);
    if (w) clearInterval(w.timer);
    this.watches.delete(system);
  }

  /** Stop every watch (daemon stop, tests). */
  stop(): void { for (const s of [...this.watches.keys()]) this.stopWatch(s); }

  /**
   * Ask OS for ONE system's tools (`x-dispatch-systems: <system>`) and keep them. True when they changed
   * (list_changed then goes to every thread with that system's server).
   */
  async refreshSystem(system: string): Promise<boolean> {
    if (!this.deps.provider.osToolsUrl() || !isSystemId(system)) return false;
    try {
      const list = await forwardToOs(this.deps, { jsonrpc: '2.0', id: 'list', method: 'tools/list', params: {} }, { 'x-dispatch-systems': system });
      const tools = (list.body as { result?: { tools?: unknown[] } } | null)?.result?.tools;
      if (list.status >= 300 || !Array.isArray(tools)) return false;
      const known = this.knownSystems();
      const mine = tools.filter((t): t is Record<string, unknown> => !!t && typeof t === 'object' && typeof (t as any).name === 'string' && toolSystem(t, known) === system);
      if (JSON.stringify(mine) === JSON.stringify(this.bySystem.get(system) ?? [])) return false;
      const next = new Map(this.bySystem);
      if (mine.length) next.set(system, mine); else next.delete(system);
      this.bySystem = next;
      setGatewayInfo({ instructions: gatewayInfo().instructions, tools: this.toolNames() });
      this.emit([system]);
      return true;
    } catch { return false; }
  }

  /** Follow OS: refresh when its answer changes; forget the list when OS turns the tools off. */
  start(): () => void {
    return this.deps.provider.onChange((s) => {
      if (!s.osTools) { this.bySystem.clear(); this.loadedAt = null; return; }
      if (s.reachable) void this.refresh();
    });
  }

  get loaded(): boolean { return this.loadedAt !== null; }

  /** Every system id OS named (entitled, consent, a tool's own). */
  knownSystems(): string[] {
    const st = this.deps.provider.snapshot();
    return [...new Set([...(st.entitled ?? []), ...st.needsConsent.map((c) => c.system), ...this.bySystem.keys(), OS_SELF_SYSTEM])];
  }

  tools(system: string): Array<Record<string, unknown>> { return this.bySystem.get(system) ?? []; }
  realNames(system: string): string[] { return this.tools(system).map((t) => String(t.name ?? '')); }

  /** The gateway's tool names per system. */
  toolNames(): Map<string, string[]> { return new Map([...this.bySystem].map(([sys, ts]) => [sys, ts.map((t) => String(t.name ?? ''))])); }

  /** Systems with at least one tool, in OS's order. */
  systems(): string[] { return [...this.bySystem.keys()]; }

  /** Ask OS for the whole list. Answers the systems whose tool set changed (empty on the first load). */
  async refresh(): Promise<string[]> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async (): Promise<string[]> => {
      if (!this.deps.provider.osToolsUrl()) return [];
      try {
        const init = await forwardToOs(this.deps, { jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dispatch-catalog', version: '1' } } }, {});
        if (init.status >= 300) return [];
        const initText = (init.body as { result?: { instructions?: unknown } } | null)?.result?.instructions;
        const list = await forwardToOs(this.deps, { jsonrpc: '2.0', id: 'list', method: 'tools/list', params: {} }, {});
        const tools = (list.body as { result?: { tools?: unknown[] } } | null)?.result?.tools;
        if (list.status >= 300 || !Array.isArray(tools)) return [];
        const known = this.knownSystems();
        const next = new Map<string, Array<Record<string, unknown>>>();
        for (const t of tools) {
          if (!t || typeof t !== 'object' || typeof (t as any).name !== 'string') continue;
          const sys = toolSystem(t, known);
          if (!sys || !isSystemId(sys)) continue;
          next.set(sys, [...(next.get(sys) ?? []), t as Record<string, unknown>]);
        }
        const before = this.loadedAt === null ? null : this.bySystem;
        this.bySystem = next;
        this.loadedAt = Date.now();
        setGatewayInfo({ instructions: typeof initText === 'string' && initText.trim() ? initText : null, tools: this.toolNames() });
        if (!before) return [];
        const changed = [...new Set([...before.keys(), ...next.keys()])]
          .filter((s) => JSON.stringify(before.get(s) ?? []) !== JSON.stringify(next.get(s) ?? []));
        // A system the person connected by another way leaves the fast watch.
        for (const s of changed) this.stopWatch(s);
        this.emit(changed);
        return changed;
      } catch { return []; /* OS away: keep the last list */ }
    })();
    try { return await this.inFlight; } finally { this.inFlight = null; }
  }

  /** Older than the ttl (or never loaded): refresh in the background. */
  refreshIfStale(): void {
    if (this.loadedAt === null || Date.now() - this.loadedAt > this.ttlMs) void this.refresh();
  }
}

/**
 * The systems that get a server at this spawn: every system with a tool in the catalog, including one
 * whose only tool is `connect` (the person has not connected it yet; the agent calls `connect`, and
 * the real tools arrive in the same thread by list_changed). Before the first load: the entitled
 * systems. OS's own `connections` always.
 */
export function systemsForSpawn(provider: OsConnectionsProvider, catalog: OsToolCatalog): string[] {
  if (!provider.osToolsUrl()) return [];
  catalog.refreshIfStale();
  const st = provider.snapshot();
  const base = catalog.loaded ? catalog.systems() : [...(st.entitled ?? [])];
  return [...new Set([...base, OS_SELF_SYSTEM])];
}

/** The company-system server specs for a thread (os/os-servers.ts), reaching OS only through this daemon. */
export function osSystemServerSpecs(daemonApi: string, systems: readonly string[]): McpServerSpec[] {
  return osServerSpecs({ daemonApi, systems, bridgePath: OS_BRIDGE_PATH });
}
