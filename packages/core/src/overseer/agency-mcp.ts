/**
 * Dispatch Agency MCP server.
 *
 * A standalone, hand-rolled stdio JSON-RPC 2.0 MCP server (no MCP SDK is
 * installed). It is spawned by the coordinator's `claude` process via the
 * `dispatch` entry in its `--mcp-config`, and gives the coordinator four tools to
 * AUTONOMOUSLY spawn + steer typed agent threads inside its own project.
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

/** The four tools the coordinator can call. */
export const TOOLS = [
  {
    name: 'spawn_agent',
    description:
      'Create a typed agent thread in this project and seed it with a task. Pick the type ' +
      'by the work needed: researcher to investigate, planner to plan, implementer to build, ' +
      'reviewer to check. Returns the new agentId.',
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
      },
      required: ['agentType', 'task'],
    },
  },
  {
    name: 'list_agents',
    description: 'List the typed agent threads in this project with their id, label, agentType, and status.',
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

async function spawnAgent(args: { agentType: AgentType; name?: string; task: string }): Promise<{ agentId: string; label: string }> {
  if (!args?.agentType) throw new Error('agentType is required');
  if (!args?.task) throw new Error('task is required');
  const label = args.name || `${args.agentType} agent`;
  const terminal = await httpJson('POST', `${apiBase()}/api/sessions/${sessionId()}/terminals`, {
    type: 'claude-code',
    label,
    config: { transport: 'structured', agentType: args.agentType, role: 'agent' },
  });
  const agentId: string | undefined = terminal?.id;
  if (!agentId) throw new Error('spawn did not return a terminal id');
  await httpJson('POST', `${apiBase()}/api/terminals/${agentId}/message`, { text: args.task });
  return { agentId, label };
}

async function listAgents(): Promise<Array<{ id: string; label: string; agentType: string | null; status: string }>> {
  const terminals = await httpJson('GET', `${apiBase()}/api/sessions/${sessionId()}/terminals`);
  const list = Array.isArray(terminals) ? terminals : [];
  return list
    .filter((t: any) => t?.config?.role === 'agent' || typeof t?.config?.agentType === 'string')
    .map((t: any) => ({ id: t.id, label: t.label, agentType: t?.config?.agentType ?? null, status: t.status }));
}

async function messageAgent(args: { agentId: string; text: string }): Promise<{ ok: true; agentId: string }> {
  if (!args?.agentId) throw new Error('agentId is required');
  if (!args?.text) throw new Error('text is required');
  await httpJson('POST', `${apiBase()}/api/terminals/${args.agentId}/message`, { text: args.text });
  return { ok: true, agentId: args.agentId };
}

async function completeAgent(args: { agentId: string }): Promise<{ ok: true; agentId: string }> {
  if (!args?.agentId) throw new Error('agentId is required');
  await httpJson('DELETE', `${apiBase()}/api/terminals/${args.agentId}`);
  return { ok: true, agentId: args.agentId };
}

/** Run a named tool and shape the result as MCP `tools/call` content. Never throws. */
export async function callTool(
  name: string,
  args: any,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    let result: unknown;
    switch (name) {
      case 'spawn_agent': result = await spawnAgent(args ?? {}); break;
      case 'list_agents': result = await listAgents(); break;
      case 'message_agent': result = await messageAgent(args ?? {}); break;
      case 'complete_agent': result = await completeAgent(args ?? {}); break;
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
