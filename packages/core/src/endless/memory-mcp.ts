/**
 * Endless Chat memory MCP server: zoom, date, and the read-only thread tools of stage 1.
 * A standalone stdio JSON-RPC 2.0 process (NDJSON), spawned by every turn and every
 * compaction through `--mcp-config`. It answers by calling the daemon's HTTP API:
 *   DISPATCH_API  base URL (default http://localhost:${DISPATCH_PORT || 3456})
 * The tool list and descriptions never change: they are part of the cached prefix.
 */
import * as readline from 'readline';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'dispatch-memory', version: '0.1.0' } as const;

function apiBase(): string {
  return process.env.DISPATCH_API || `http://localhost:${process.env.DISPATCH_PORT || 3456}`;
}

export const TOOLS = [
  {
    name: 'zoom',
    description: 'Open the line id+n of the view into the two lines of n/2 under it; n = 1 gives the message whole.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'The first message of the line: the number before "+".' },
        n: { type: 'integer', description: 'The number of messages the line covers: the number after "+", a power of 2.' },
      },
      required: ['id', 'n'],
    },
  },
  {
    name: 'date',
    description: 'The date and time of message id.',
    inputSchema: { type: 'object', properties: { id: { type: 'integer', description: 'The message id.' } }, required: ['id'] },
  },
  {
    name: 'list_threads',
    description: 'List the Dispatch threads of every project: id, project, label, type, status and last activity.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'read_thread',
    description: "Read a thread's transcript: its assistant output and the tools it ran. Pass tail to cap how many recent items are read (default 200).",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The thread id (from list_threads).' },
        tail: { type: 'integer', description: 'How many recent conversation items to read (default 200).' },
      },
      required: ['id'],
    },
  },
] as const;

async function getJson(url: string): Promise<any> {
  const res = await fetch(url);
  const text = await res.text().catch(() => '');
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) throw new Error(typeof body?.error === 'string' ? body.error : `GET ${url} -> ${res.status}`);
  return body;
}

type McpContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

export async function callTool(name: string, args: any): Promise<{ content: McpContent[]; isError?: boolean }> {
  try {
    const a = args ?? {};
    switch (name) {
      case 'zoom': {
        const r = await getJson(`${apiBase()}/api/endless/zoom?id=${Number(a.id)}&n=${Number(a.n)}`);
        const images: McpContent[] = (Array.isArray(r?.images) ? r.images : []).map((im: any) => ({ type: 'image', data: String(im.data), mimeType: String(im.mimeType) }));
        return { content: [{ type: 'text', text: String(r?.text ?? '') }, ...images] };
      }
      case 'date': {
        const r = await getJson(`${apiBase()}/api/endless/date?id=${Number(a.id)}`);
        return { content: [{ type: 'text', text: String(r?.text ?? '') }] };
      }
      case 'list_threads': {
        const r = await getJson(`${apiBase()}/api/endless/threads`);
        return { content: [{ type: 'text', text: JSON.stringify(r) }] };
      }
      case 'read_thread': {
        if (!a.id) throw new Error('id is required');
        const tail = Number.isInteger(a.tail) && a.tail > 0 ? a.tail : 200;
        const conv = await getJson(`${apiBase()}/api/terminals/${encodeURIComponent(String(a.id))}/conversation?limit=${tail}`);
        const items: any[] = Array.isArray(conv?.items) ? conv.items : [];
        const output = items.filter((it) => it?.kind === 'assistant' && it.text).map((it) => it.text).join('\n\n').trim();
        const tools = items.filter((it) => it?.kind === 'tool' && it.toolName).map((it) => String(it.toolName)).slice(-30);
        return { content: [{ type: 'text', text: JSON.stringify({ id: String(a.id), output: output || '(no assistant output yet)', tools }) }] };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err: any) {
    return { content: [{ type: 'text', text: `Error: ${err?.message ?? String(err)}` }], isError: true };
  }
}

interface JsonRpcRequest { jsonrpc: '2.0'; id?: string | number | null; method: string; params?: any }
interface JsonRpcResponse { jsonrpc: '2.0'; id: string | number | null; result?: unknown; error?: { code: number; message: string } }

export async function handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  const { id, method, params } = req;
  const isNotification = id === undefined || id === null;
  switch (method) {
    case 'initialize':
      return { jsonrpc: '2.0', id: id ?? null, result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO } };
    case 'tools/list':
      return { jsonrpc: '2.0', id: id ?? null, result: { tools: TOOLS } };
    case 'tools/call':
      return { jsonrpc: '2.0', id: id ?? null, result: await callTool(params?.name, params?.arguments) };
    case 'ping':
      return { jsonrpc: '2.0', id: id ?? null, result: {} };
    default:
      if (isNotification) return null;
      return { jsonrpc: '2.0', id: id ?? null, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

export function startStdioServer(): void {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req: JsonRpcRequest;
    try { req = JSON.parse(trimmed); } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
      return;
    }
    void handleRequest(req).then((res) => { if (res) process.stdout.write(JSON.stringify(res) + '\n'); }).catch(() => {});
  });
  rl.on('close', () => process.exit(0));
}

// Start only when run as the entry point (`node dist/endless/memory-mcp.js`), not when imported by tests.
if (process.argv[1] && /memory-mcp\.(js|mjs|ts)$/.test(process.argv[1])) {
  startStdioServer();
}
