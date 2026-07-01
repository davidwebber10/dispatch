/**
 * Dispatch Agency MCP server.
 *
 * A standalone, hand-rolled stdio JSON-RPC 2.0 MCP server (no MCP SDK is
 * installed). It is spawned by the coordinator's `claude` process via the
 * `dispatch` entry in its `--mcp-config`, and gives the coordinator the tools to
 * AUTONOMOUSLY spawn + steer typed agent threads inside its own project, organized
 * into named missions.
 *
 * Framing: line-delimited JSON (NDJSON) — one JSON-RPC message per line on
 * stdin, one JSON-RPC response per line on stdout. This is the MCP stdio
 * transport convention (messages are newline-delimited and MUST NOT contain
 * embedded newlines); it is simpler than LSP-style Content-Length framing and is
 * what the Claude CLI speaks over stdio.
 *
 * It does the real work by calling the Dispatch HTTP API with global `fetch`:
 *   - DISPATCH_SESSION  the coordinator's project sessionId (agents land here)
 *   - DISPATCH_API      base URL (default `http://localhost:${DISPATCH_PORT||3456}`)
 *   - DISPATCH_PORT     port used to build the default DISPATCH_API
 *
 * Every tool returns MCP `isError` content on failure — the process never
 * crashes on a bad request.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'dispatch-agency', version: '0.1.0' } as const;

export type AgentType = 'planner' | 'implementer' | 'researcher' | 'reviewer';

function apiBase(): string {
  return process.env.DISPATCH_API || `http://localhost:${process.env.DISPATCH_PORT || 3456}`;
}
function sessionId(): string {
  return process.env.DISPATCH_SESSION || '';
}

/** The tools the coordinator can call. */
export const TOOLS = [
  {
    name: 'spawn_agent',
    description:
      'Create a typed agent thread in this project and seed it with a task. Pick the type ' +
      'by the work needed: researcher to investigate, planner to plan, implementer to build, ' +
      'reviewer to check. Group related work by passing a concise `mission` name (e.g. ' +
      '"Auth refactor"); reuse the SAME mission for related agents so the rail groups them ' +
      'under one initiative (call list_missions first to reuse an existing name). Returns the new agentId.',
    inputSchema: {
      type: 'object',
      properties: {
        agentType: {
          type: 'string',
          enum: ['planner', 'implementer', 'researcher', 'reviewer'],
          description: 'The kind of agent to spawn.',
        },
        name: { type: 'string', description: 'Optional label for the agent thread.' },
        task: { type: 'string', description: 'The task / mission to seed the agent with.' },
        mission: {
          type: 'string',
          description:
            'Optional concise mission name that groups this agent with related work ' +
            '(e.g. "Auth refactor"). Reuse the same name across related agents; defaults to "General" when unset.',
        },
      },
      required: ['agentType', 'task'],
    },
  },
  {
    name: 'queue_agent',
    description:
      'Like spawn_agent, but QUEUE the agent instead of starting it: the thread is created and its ' +
      'task is parked, but no process runs until you call start_agent. Use this to line up work ' +
      "you're not ready to run yet — stage a batch, respect a dependency, or pace how many agents run " +
      'at once — without paying for a live process per queued agent. Pass `dependsOn` to auto-start it ' +
      "the moment that agent finishes: it's spawned automatically and receives the finished agent's " +
      'final output prepended to its task (no need to call start_agent yourself). If the dependency has ' +
      'already finished, it starts immediately. Otherwise same args as spawn_agent; group related work ' +
      'with a shared `mission`. Returns the new agentId (its status is "queued").',
    inputSchema: {
      type: 'object',
      properties: {
        agentType: {
          type: 'string',
          enum: ['planner', 'implementer', 'researcher', 'reviewer'],
          description: 'The kind of agent to queue.',
        },
        name: { type: 'string', description: 'Optional label for the agent thread.' },
        task: { type: 'string', description: 'The task / mission to park on the agent; delivered when start_agent runs it.' },
        mission: {
          type: 'string',
          description:
            'Optional concise mission name that groups this agent with related work ' +
            '(e.g. "Auth refactor"). Reuse the same name across related agents; defaults to "General" when unset.',
        },
        dependsOn: {
          type: 'string',
          description:
            'Optional agentId this queued agent should wait on. When that agent finishes, this one ' +
            "auto-starts with the finished agent's final output added as context ahead of its task. " +
            'Already-finished dependency? It starts right away.',
        },
      },
      required: ['agentType', 'task'],
    },
  },
  {
    name: 'start_agent',
    description:
      'Start a queued agent (created by queue_agent): spawn its process and deliver its parked task. ' +
      'The agent begins working immediately. No-op if the agent was already started. If the agent has ' +
      'an unmet `dependsOn`, this starts it early anyway, with its original task and no injected context.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'The queued agent thread id (from queue_agent / list_agents).' },
      },
      required: ['agentId'],
    },
  },
  {
    name: 'list_agents',
    description: 'List the typed agent threads in this project with their id, label, agentType, and status.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_missions',
    description:
      'List the distinct missions agents are grouped under, with counts: [{ mission, live, total }] ' +
      '(live = agents not yet done). Call this before spawn_agent to reuse an existing mission name ' +
      'for related work instead of fragmenting into many one-off groups.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'message_agent',
    description: 'Send a follow-up message to an existing agent thread to steer or correct it.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'The agent thread id (from spawn_agent / list_agents).' },
        text: { type: 'string', description: 'The message to send to the agent.' },
      },
      required: ['agentId', 'text'],
    },
  },
  {
    name: 'answer_agent',
    description:
      'Answer a question one of your agents raised — it is PAUSED until you do. When an agent asks, ' +
      'you receive a "🔔 Your agent … is PAUSED" message listing the question header(s) and options; ' +
      'decide based on the mission and answer here. Provide `answers` as a map of each question header ' +
      'to your chosen option label, exactly as listed (or use `answer` for a single-question prompt).',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'The paused agent thread id (from the notification / list_agents).' },
        answers: {
          type: 'object',
          description: 'Map of question header -> chosen option label, e.g. { "Approach": "Use Postgres" }.',
          additionalProperties: { type: 'string' },
        },
        answer: { type: 'string', description: 'Shortcut for a single-question prompt: just the chosen option label (used when `answers` is omitted).' },
      },
      required: ['agentId'],
    },
  },
  {
    name: 'read_agent',
    description:
      "Read an agent's actual OUTPUT — its assistant text (findings, plan, report) and the tools it ran. " +
      'Use this to INGEST what an agent produced: after a "✅ … finished a turn" notice, or any time you ' +
      'need to see an agent\'s work. list_agents only returns status, never content — read_agent is the ' +
      'read channel. Returns { status, output, tools }.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'The agent thread id (from spawn_agent / list_agents / a completion notice).' },
      },
      required: ['agentId'],
    },
  },
  {
    name: 'complete_agent',
    description: 'Mark an agent done and archive its thread once its work is finished.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'The agent thread id to complete / archive.' },
      },
      required: ['agentId'],
    },
  },
  {
    name: 'post_image',
    description:
      'Show the user an image INLINE in this conversation — a screenshot, chart, diagram, rendered ' +
      'UI, or any visual an agent produced (e.g. a file an agent saved under .dispatch/inbox). Pass ' +
      '`path`, a path to an image file inside this project (png/jpg/jpeg/gif/webp/svg); it is read and ' +
      'rendered in the Control Plane thread the user is watching. Reach for this whenever a picture conveys ' +
      'the result better than words — to surface a screenshot of a working change, a generated graph, ' +
      'or a visual diff — rather than only describing it. The path must be inside the project working ' +
      'directory (paths outside it are rejected).',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Path to an image file inside this project, relative to the project root ' +
            '(e.g. ".dispatch/inbox/screenshot.png").',
        },
        alt: { type: 'string', description: 'Optional alt text / caption describing the image.' },
      },
      required: ['path'],
    },
  },
] as const;

// --- HTTP helper -----------------------------------------------------------

async function httpJson(method: string, url: string, body?: unknown): Promise<any> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let detail = '';
    try { detail = await res.text(); } catch { /* ignore */ }
    throw new Error(`${method} ${url} -> ${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`);
  }
  const text = await res.text().catch(() => '');
  if (!text) return null; // 204 / empty body
  try { return JSON.parse(text); } catch { return text; }
}

// --- tool implementations --------------------------------------------------

async function spawnAgent(args: { agentType: AgentType; name?: string; task: string; mission?: string }): Promise<{ agentId: string; label: string; mission?: string }> {
  if (!args?.agentType) throw new Error('agentType is required');
  if (!args?.task) throw new Error('task is required');
  const label = args.name || `${args.agentType} agent`;
  const mission = typeof args.mission === 'string' ? args.mission.trim() : '';
  const terminal = await httpJson('POST', `${apiBase()}/api/sessions/${sessionId()}/terminals`, {
    type: 'claude-code',
    label,
    config: { transport: 'structured', agentType: args.agentType, role: 'agent', ...(mission ? { mission } : {}) },
  });
  const agentId: string | undefined = terminal?.id;
  if (!agentId) throw new Error('spawn did not return a terminal id');
  await httpJson('POST', `${apiBase()}/api/terminals/${agentId}/message`, { text: args.task, source: 'coordinator' });
  return { agentId, label, ...(mission ? { mission } : {}) };
}

/**
 * Queue an agent: create the thread with the task parked (`queued:true`) but DON'T spawn its
 * process — the create route routes this to createQueuedTerminal (status='queued', no CLI). A
 * later start_agent promotes it — or, when `dependsOn` is set, the server auto-promotes it once
 * that agent finishes (see SessionService.startQueuedDependents), or immediately if it already
 * has. `dependsOn` rides inside `config` (opaque to the route) alongside the other agent markers.
 * Mirrors spawnAgent's args/mission handling.
 */
async function queueAgent(args: { agentType: AgentType; name?: string; task: string; mission?: string; dependsOn?: string }): Promise<{ agentId: string; label: string; mission?: string; queued: true }> {
  if (!args?.agentType) throw new Error('agentType is required');
  if (!args?.task) throw new Error('task is required');
  const label = args.name || `${args.agentType} agent`;
  const mission = typeof args.mission === 'string' ? args.mission.trim() : '';
  const dependsOn = typeof args.dependsOn === 'string' ? args.dependsOn.trim() : '';
  const terminal = await httpJson('POST', `${apiBase()}/api/sessions/${sessionId()}/terminals`, {
    type: 'claude-code',
    label,
    queued: true,
    task: args.task,
    config: {
      transport: 'structured', agentType: args.agentType, role: 'agent',
      ...(mission ? { mission } : {}), ...(dependsOn ? { dependsOn } : {}),
    },
  });
  const agentId: string | undefined = terminal?.id;
  if (!agentId) throw new Error('queue did not return a terminal id');
  return { agentId, label, ...(mission ? { mission } : {}), queued: true };
}

/** Promote a queued agent to a running one: spawn its process + deliver its parked task. */
async function startAgent(args: { agentId: string }): Promise<{ ok: true; agentId: string }> {
  if (!args?.agentId) throw new Error('agentId is required');
  await httpJson('POST', `${apiBase()}/api/terminals/${args.agentId}/start`);
  return { ok: true, agentId: args.agentId };
}

/** Predicate: a terminal is one of our spawned typed agents (vs the coordinator / plain tabs). */
function isAgentTerminal(t: any): boolean {
  return t?.config?.role === 'agent' || typeof t?.config?.agentType === 'string';
}

async function listAgents(): Promise<Array<{ id: string; label: string; agentType: string | null; status: string }>> {
  const terminals = await httpJson('GET', `${apiBase()}/api/sessions/${sessionId()}/terminals`);
  const list = Array.isArray(terminals) ? terminals : [];
  return list
    .filter(isAgentTerminal)
    .map((t: any) => ({ id: t.id, label: t.label, agentType: t?.config?.agentType ?? null, status: t.status }));
}

/**
 * Distinct mission names the spawned agents are grouped under, with counts. Mirrors the
 * rail's grouping (web live.ts groupByMission): a missing/blank `config.mission` falls
 * back to "General". `live` = agents not yet `done`; `total` = all agents in that mission.
 * Lets the coordinator reuse an existing mission name instead of fragmenting the rail.
 */
async function listMissions(): Promise<Array<{ mission: string; live: number; total: number }>> {
  const terminals = await httpJson('GET', `${apiBase()}/api/sessions/${sessionId()}/terminals`);
  const list = Array.isArray(terminals) ? terminals : [];
  const counts = new Map<string, { mission: string; live: number; total: number }>();
  for (const t of list.filter(isAgentTerminal)) {
    const mn = typeof t?.config?.mission === 'string' && t.config.mission.trim() ? t.config.mission.trim() : 'General';
    let entry = counts.get(mn);
    if (!entry) { entry = { mission: mn, live: 0, total: 0 }; counts.set(mn, entry); }
    entry.total++;
    if (t.status !== 'done') entry.live++;
  }
  return Array.from(counts.values());
}

async function messageAgent(args: { agentId: string; text: string }): Promise<{ ok: true; agentId: string }> {
  if (!args?.agentId) throw new Error('agentId is required');
  if (!args?.text) throw new Error('text is required');
  await httpJson('POST', `${apiBase()}/api/terminals/${args.agentId}/message`, { text: args.text, source: 'coordinator' });
  return { ok: true, agentId: args.agentId };
}

async function completeAgent(args: { agentId: string }): Promise<{ ok: true; agentId: string }> {
  if (!args?.agentId) throw new Error('agentId is required');
  await httpJson('DELETE', `${apiBase()}/api/terminals/${args.agentId}`);
  return { ok: true, agentId: args.agentId };
}

/**
 * The READ channel: pull an agent's output so the coordinator can ingest it. Fetches the
 * agent's transcript and returns its assistant text (the substantive findings/report) plus
 * the tools it ran and its current status. This is what closes the orchestration loop —
 * list_agents gives status, read_agent gives content.
 */
async function readAgent(args: { agentId: string }): Promise<{ agentId: string; status: string | null; output: string; tools: string[] }> {
  if (!args?.agentId) throw new Error('agentId is required');
  const conv = await httpJson('GET', `${apiBase()}/api/terminals/${args.agentId}/conversation?limit=500`);
  const items: any[] = Array.isArray(conv?.items) ? conv.items : [];
  const output = items.filter((it) => it?.kind === 'assistant' && it.text).map((it) => it.text).join('\n\n').trim();
  const tools = items.filter((it) => it?.kind === 'tool' && it.toolName).map((it) => it.toolName as string);
  let status: string | null = null;
  try { const t = await httpJson('GET', `${apiBase()}/api/terminals/${args.agentId}`); status = t?.status ?? null; } catch { /* ignore */ }
  return { agentId: args.agentId, status, output: output || '(no assistant output captured yet)', tools: tools.slice(-30) };
}

/**
 * Answer a paused agent's AskUserQuestion. Resolves the agent's pending permission via the
 * existing /permission endpoint, folding the chosen option(s) in as the AskUserQuestion
 * `answers` map. Accepts either an explicit `answers` map (question header -> option label) or,
 * for a single-question prompt, a bare `answer` (we look up the question's header to key it).
 */
async function answerAgent(args: { agentId: string; answers?: Record<string, string>; answer?: string }): Promise<{ ok: true; agentId: string }> {
  if (!args?.agentId) throw new Error('agentId is required');
  let answers = args.answers && typeof args.answers === 'object' ? args.answers : undefined;
  if ((!answers || Object.keys(answers).length === 0) && typeof args.answer === 'string' && args.answer.trim()) {
    const pending = await httpJson('GET', `${apiBase()}/api/terminals/${args.agentId}/permission`);
    const header = pending?.questions?.[0]?.header || 'question';
    answers = { [header]: args.answer };
  }
  if (!answers || Object.keys(answers).length === 0) {
    throw new Error('provide `answers` (map of question header -> chosen option) or `answer` (single option label)');
  }
  await httpJson('POST', `${apiBase()}/api/terminals/${args.agentId}/permission`, { decision: 'allow', answers });
  return { ok: true, agentId: args.agentId };
}

// --- post_image (surface a picture inline in the coordinator thread) -------

/** Extension → MIME for the images the byte route serves; the gate that keeps this read-image-only. */
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

/**
 * Resolve `requestedPath` within `root`, or null if it escapes the sandbox. Mirrors the
 * byte route's resolveSafe (routes/files.ts): an absolute or `..` path landing outside the
 * root is rejected; in-tree paths (e.g. `.dispatch/inbox/shot.png`) pass.
 */
function resolveSafe(root: string, requestedPath: string): string | null {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, requestedPath);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return resolved;
}

/** An MCP image content block — base64 bytes + mime (+ best-effort alt the foundation parser reads). */
type McpImageContent = { type: 'image'; data: string; mimeType: string; alt?: string };

/**
 * Read a project image file and return it as an MCP image content block so it renders INLINE in
 * the Control Plane thread. The path is sandboxed to the MCP server's working dir — which is the
 * coordinator's project root, so the session working dir (mirrors the byte route's resolveSafe) —
 * and only the known image extensions are accepted, so this can't be turned into an arbitrary-file
 * read. base64 is the MCP transport for binary content; `mimeType` lets the host render it.
 */
async function postImage(args: { path: string; alt?: string }): Promise<McpImageContent> {
  if (!args?.path) throw new Error('path is required');
  const resolved = resolveSafe(process.cwd(), args.path);
  if (!resolved) throw new Error('path is outside the working directory');
  const mimeType = IMAGE_MIME[path.extname(resolved).toLowerCase()];
  if (!mimeType) throw new Error('unsupported image type (expected png/jpg/jpeg/gif/webp/svg)');
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error('not a file');
  const data = fs.readFileSync(resolved).toString('base64');
  const alt = typeof args.alt === 'string' && args.alt.trim() ? args.alt : undefined;
  return { type: 'image', data, mimeType, ...(alt ? { alt } : {}) };
}

/** An MCP `tools/call` content block: text for data tools, an image block for post_image. */
type McpContent = { type: 'text'; text: string } | McpImageContent;

/** Run a named tool and shape the result as MCP `tools/call` content. Never throws. */
export async function callTool(
  name: string,
  args: any,
): Promise<{ content: McpContent[]; isError?: boolean }> {
  try {
    let result: unknown;
    switch (name) {
      case 'spawn_agent': result = await spawnAgent(args ?? {}); break;
      case 'queue_agent': result = await queueAgent(args ?? {}); break;
      case 'start_agent': result = await startAgent(args ?? {}); break;
      case 'list_agents': result = await listAgents(); break;
      case 'list_missions': result = await listMissions(); break;
      case 'message_agent': result = await messageAgent(args ?? {}); break;
      case 'answer_agent': result = await answerAgent(args ?? {}); break;
      case 'read_agent': result = await readAgent(args ?? {}); break;
      case 'complete_agent': result = await completeAgent(args ?? {}); break;
      // post_image's result IS the content block (an image, not JSON text) — return it directly.
      case 'post_image': return { content: [await postImage(args ?? {})] };
      default: throw new Error(`Unknown tool: ${name}`);
    }
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (err: any) {
    return { content: [{ type: 'text', text: `Error: ${err?.message ?? String(err)}` }], isError: true };
  }
}

// --- JSON-RPC 2.0 dispatch -------------------------------------------------

interface JsonRpcRequest { jsonrpc: '2.0'; id?: string | number | null; method: string; params?: any }
interface JsonRpcResponse { jsonrpc: '2.0'; id: string | number | null; result?: unknown; error?: { code: number; message: string } }

function isNotification(id: JsonRpcRequest['id']): boolean {
  return id === undefined || id === null;
}

/**
 * Handle one JSON-RPC message. Returns the response object to write, or null for
 * notifications (no `id`) which get no reply.
 */
export async function handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  const { id, method, params } = req;
  try {
    switch (method) {
      case 'initialize':
        return { jsonrpc: '2.0', id: id ?? null, result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO } };
      case 'tools/list':
        return { jsonrpc: '2.0', id: id ?? null, result: { tools: TOOLS } };
      case 'tools/call': {
        const result = await callTool(params?.name, params?.arguments);
        return { jsonrpc: '2.0', id: id ?? null, result };
      }
      case 'ping':
        return { jsonrpc: '2.0', id: id ?? null, result: {} };
      default:
        if (isNotification(id)) return null; // e.g. notifications/initialized
        return { jsonrpc: '2.0', id: id ?? null, error: { code: -32601, message: `Method not found: ${method}` } };
    }
  } catch (err: any) {
    if (isNotification(id)) return null;
    return { jsonrpc: '2.0', id: id ?? null, error: { code: -32603, message: err?.message ?? String(err) } };
  }
}

/** Read NDJSON requests from stdin, write NDJSON responses to stdout. */
export function startStdioServer(): void {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed);
    } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
      return;
    }
    void handleRequest(req)
      .then((res) => { if (res) process.stdout.write(JSON.stringify(res) + '\n'); })
      .catch(() => { /* never crash the server on a single bad request */ });
  });
  rl.on('close', () => process.exit(0));
}

// Start the server only when this module is the entry point (spawned via
// `node dist/overseer/agency-mcp.js`), not when imported by tests.
if (process.argv[1] && /agency-mcp\.(js|mjs|ts)$/.test(process.argv[1])) {
  startStdioServer();
}
