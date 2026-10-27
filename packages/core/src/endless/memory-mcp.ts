/**
 * Endless Chat memory MCP server: zoom, date, the thread tools, and the Chat ledger tools.
 * A standalone stdio JSON-RPC 2.0 process (NDJSON), spawned by every turn and every
 * compaction through `--mcp-config`. It answers by calling the daemon's HTTP API:
 *   DISPATCH_AUTH the Chat key (dck_), sent only to DISPATCH_API
 *   DISPATCH_API  base URL (default http://localhost:${DISPATCH_PORT || 3456})
 * The tool list and descriptions never change: they are part of the cached prefix.
 */
import * as readline from 'readline';
import {
  createWorker, sendTask, readAgentOutput, pendingQuestionOf, authHeaders, keyErrorFrom, AGENT_TYPES, HARNESSES, HARNESS_ARG_DESCRIPTION, TITLE_RULES, CARD_FIELDS_SCHEMA, type AgentType,
} from '../overseer/agency-shared.js';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'dispatch-memory', version: '0.1.0' } as const;

function apiBase(): string {
  return process.env.DISPATCH_API || `http://localhost:${process.env.DISPATCH_PORT || 3456}`;
}

const PROJECT_ARG = { type: 'string', description: 'The project: its name or id, as the status block shows it.' } as const;

/**
 * The ledger card fields for Chat: the Control Plane's CARD_FIELDS_SCHEMA without the source
 * kind "user" (Chat has no quote of the user; the route refuses it too). A derived copy, so the
 * Control Plane schema stays as it is.
 */
const { source: CP_SOURCE, ...CARD_FIELDS_NO_SOURCE } = CARD_FIELDS_SCHEMA;
const CHAT_CARD_FIELDS_SCHEMA = {
  ...CARD_FIELDS_NO_SOURCE,
  source: {
    ...CP_SOURCE,
    properties: {
      ...CP_SOURCE.properties,
      kind: { type: 'string', enum: CP_SOURCE.properties.kind.enum.filter((k) => k !== 'user') },
      ref: {
        type: 'string',
        description: CP_SOURCE.properties.ref.description.replace(" user: the user's exact words;", ''),
      },
    },
  },
};

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
  {
    name: 'spawn_agent',
    description:
      'Start a Dispatch thread in a project\'s folder and give it a task. Its report reaches you later as a work ' +
      'message starting "[Name]"; never wait for it. Pick agentType by the work: researcher to investigate, planner ' +
      'to plan, implementer to build, reviewer to check, design-reviewer or code-reviewer only to gate a plan or a ' +
      'finished diff. Returns the thread id.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_ARG,
        agentType: { type: 'string', enum: AGENT_TYPES, description: 'The kind of thread.' },
        task: { type: 'string', description: 'The task brief: everything the thread needs, with absolute paths. The thread does not see your memory.' },
        name: { type: 'string', description: 'Optional short label for the thread. Its report starts with it.' },
        mission: { type: 'string', description: 'Optional mission name that groups related threads in the project.' },
        model: { type: 'string', description: 'Optional model override for its harness. Omit to use the default for the type.' },
        harness: { type: 'string', enum: HARNESSES, description: HARNESS_ARG_DESCRIPTION },
      },
      required: ['project', 'agentType', 'task'],
    },
  },
  {
    name: 'message_thread',
    description: 'Send a message to a thread you started with spawn_agent, in any project, to steer it or answer it. If the thread is waiting on a question card, the text answers the card (use the user\'s own words or a clear earlier instruction of the user; otherwise ask the user first). It reports again when it next finishes. Other threads are refused.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The thread id (from spawn_agent or list_threads).' },
        text: { type: 'string', description: 'The message.' },
      },
      required: ['id', 'text'],
    },
  },
  {
    name: 'read_agent',
    description: "Read a thread's status and output: its assistant text and the tools it ran.",
    inputSchema: { type: 'object', properties: { agentId: { type: 'string', description: 'The thread id.' } }, required: ['agentId'] },
  },
  {
    name: 'ledger_list',
    description: "List a project's decision ledger: the open items, the recent decisions, and the project rules.",
    inputSchema: { type: 'object', properties: { project: PROJECT_ARG }, required: ['project'] },
  },
  {
    name: 'ledger_show',
    description: "Show items of a project's ledger as full cards: pass ids (e.g. [\"N17\"]), or all: true for every open item.",
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_ARG,
        ids: { type: 'array', items: { type: 'string' }, description: 'Item ids, e.g. ["N17"].' },
        all: { type: 'boolean', description: 'true shows every open item.' },
      },
      required: ['project'],
    },
  },
  {
    name: 'ledger_add',
    description:
      'Record an item that needs the user in a project\'s decision ledger: kind "go" (a merge, deploy or release ' +
      'approval), "decide" (a choice) or "do" (a manual step for the user). A go or decide item is a full decision ' +
      'card: it needs context, default and source; a decide item also needs at least 2 options with a ' +
      'recommendation and why. Every item needs a title. The source kind "user" is not available here. ' +
      'Returns { id, line }.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_ARG,
        kind: { type: 'string', enum: ['go', 'decide', 'do'], description: 'go = an approval, decide = a choice, do = a manual step for the user.' },
        text: { type: 'string', description: 'The question as the user will see it: one decision. It never changes after creation.' },
        title: { type: 'string', description: `${TITLE_RULES} Required.` },
        ...CHAT_CARD_FIELDS_SCHEMA,
        blocks: { type: 'string', description: 'Optional: what this item holds up.' },
        mission: { type: 'string', description: 'Optional mission name this item belongs to.' },
      },
      required: ['project', 'kind', 'text', 'title'],
    },
  },
  {
    name: 'ledger_resolve',
    description: "Withdraw an open item of a project's ledger, with a reason. The user answers or parks items in the project's Control Plane.",
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_ARG,
        id: { type: 'string', description: 'The item id, e.g. "N12".' },
        status: { type: 'string', enum: ['withdrawn'], description: 'Always "withdrawn".' },
        reason: { type: 'string', description: 'Why the item is no longer needed.' },
      },
      required: ['project', 'id', 'status', 'reason'],
    },
  },
  {
    name: 'ledger_set_title',
    description: "Set or change the title of an item in a project's ledger.",
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_ARG,
        id: { type: 'string', description: 'The item id, e.g. "N12".' },
        title: { type: 'string', description: TITLE_RULES },
      },
      required: ['project', 'id', 'title'],
    },
  },
] as const;

type McpContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

/** Call the daemon; a failure throws the route's own `{ error }` text. */
async function requestJson(method: string, url: string, body?: unknown): Promise<any> {
  const res = await fetch(url, {
    method,
    headers: authHeaders(url, body !== undefined ? { 'content-type': 'application/json' } : undefined),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text().catch(() => '');
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) { const keyErr = keyErrorFrom(res.status, text); if (keyErr) throw keyErr; }
  if (!res.ok) throw Object.assign(new Error(typeof data?.error === 'string' ? data.error : `${method} ${url} -> ${res.status}`), { status: res.status });
  return data;
}
const getJson = (url: string): Promise<any> => requestJson('GET', url);
const asText = (v: unknown): { content: McpContent[] } => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }] });
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
/** Take back the report one arm owed. Best effort: the send error is what the tool returns. */
const disarm = (terminalId: string): Promise<unknown> =>
  requestJson('POST', `${apiBase()}/api/endless/disarm`, { terminalId }).catch(() => null);

/**
 * The pending question of a thread that Chat started. Chat's key may read nothing else of this route
 * (a thread of the owner's gives 403), so the row's origin is checked first and no refused request is made.
 */
async function pendingQuestionOfChatThread(row: any, id: string): Promise<Awaited<ReturnType<typeof pendingQuestionOf>>> {
  return row?.config?.origin === 'endless' ? pendingQuestionOf(apiBase(), id) : null;
}

/** The thread row, or null when it cannot be read. */
const rowOf = (id: string): Promise<any> => getJson(`${apiBase()}/api/terminals/${encodeURIComponent(id)}`).catch(() => null);

const WAITING_NOTE =
  'This thread is waiting on a question card: it is blocked until the question is answered. ' +
  'message_thread with the answer as the text answers the card; the thread then continues. ' +
  "Answer with the user's own words or a clear earlier instruction of the user; if you do not have one, ask the user. " +
  'If the thread runs on a harness that cannot take a reply to a card (Codex), the text queues behind the card and the card must be answered in the browser.';

/**
 * A thread parked on an AskUserQuestion card still reads "working" with stale text. When a question
 * is pending, say so: status needs_input, the question with its options, and what to do about it.
 */
function withPendingQuestion(out: object, pending: Awaited<ReturnType<typeof pendingQuestionOf>>): object {
  return pending ? { ...out, status: 'needs_input', pendingQuestion: pending, note: WAITING_NOTE } : out;
}

/**
 * Send Chat's text to a thread. A thread parked on a question card takes a normal turn only after
 * the card resolves, so the text answers the card (the same reply as the thread's own chat box).
 * When the card is gone (404) or the harness cannot take a reply (409), the text goes as a normal turn.
 */
async function deliverMessage(id: string, text: string): Promise<Record<string, unknown>> {
  const pending = await pendingQuestionOf(apiBase(), id);
  let fellBack = '';
  if (pending) {
    try {
      await requestJson('POST', `${apiBase()}/api/terminals/${encodeURIComponent(id)}/permission`, { decision: 'deny', reply: text, requestId: pending.requestId });
      return { ok: true, id, path: 'question-answer', note: 'The thread was waiting on a question card. Your text answered the question card; the thread is working again.' };
    } catch (err: any) {
      if (err?.status === 409) fellBack = 'The thread was waiting on a question card, but its harness cannot take a reply to a question. The text was sent as a normal turn, which may stay queued until the card is answered in the browser.';
      else if (err?.status === 404) {
        // The card may be gone, or replaced by a new question: the text was for the old one, so do not send it behind the new one.
        const now = await pendingQuestionOf(apiBase(), id);
        if (now) throw new Error(`The question changed while you were answering: a new question card is pending (requestId ${now.requestId}). Nothing was sent. Read it with read_agent and answer again.`);
        fellBack = 'The question card was already gone. The text was sent as a normal turn.';
      }
      else throw err;
    }
  }
  await sendTask(apiBase(), id, text);
  return { ok: true, id, path: 'turn', ...(fellBack ? { note: fellBack } : {}) };
}

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
        const row = await rowOf(String(a.id));
        const status = typeof row?.status === 'string' ? row.status : null;
        return asText(withPendingQuestion({ id: String(a.id), ...(status ? { status } : {}), output: output || '(no assistant output yet)', tools }, await pendingQuestionOfChatThread(row, String(a.id))));
      }
      case 'spawn_agent': {
        if (!AGENT_TYPES.includes(a.agentType)) throw new Error(`agentType must be one of: ${AGENT_TYPES.join(', ')}`);
        if (!str(a.task)) throw new Error('task is required');
        const project = await requestJson('GET', `${apiBase()}/api/endless/project?ref=${encodeURIComponent(str(a.project))}`);
        const label = str(a.name) || `${a.agentType} agent`;
        const agentId = await createWorker(apiBase(), project.id, {
          agentType: a.agentType as AgentType, label, mission: str(a.mission), model: str(a.model), harness: str(a.harness), spawnDepth: 1, origin: 'endless',
        });
        // A thread that never got its task must not owe a report, nor stay as an empty thread.
        let armed = false;
        try {
          await requestJson('POST', `${apiBase()}/api/endless/arm`, { terminalId: agentId });
          armed = true;
          await sendTask(apiBase(), agentId, String(a.task));
        } catch (err) {
          if (armed) await disarm(agentId);
          await requestJson('DELETE', `${apiBase()}/api/terminals/${encodeURIComponent(agentId)}`).catch(() => {});
          throw err;
        }
        return asText({ agentId, label, project: project.name, projectId: project.id, folder: project.folder });
      }
      case 'message_thread': {
        if (!str(a.id)) throw new Error('id is required');
        if (!str(a.text)) throw new Error('text is required');
        const id = str(a.id);
        await requestJson('POST', `${apiBase()}/api/endless/arm`, { terminalId: id });
        try {
          return asText(await deliverMessage(id, String(a.text)));
        } catch (err) {
          await disarm(id); // the message never arrived: it owes no report
          throw err;
        }
      }
      case 'read_agent': {
        if (!str(a.agentId)) throw new Error('agentId is required');
        const out = await readAgentOutput(apiBase(), str(a.agentId));
        return asText(withPendingQuestion(out, await pendingQuestionOfChatThread(await rowOf(str(a.agentId)), str(a.agentId))));
      }
      case 'ledger_list': {
        const r = await requestJson('POST', `${apiBase()}/api/endless/ledger/list`, { project: a.project });
        const rules: string[] = Array.isArray(r?.rules) ? r.rules : [];
        return asText([String(r?.text ?? ''), ...(rules.length ? [['Project rules:', ...rules.map((x) => `- ${x}`)].join('\n')] : [])].join('\n\n'));
      }
      case 'ledger_show': {
        const r = await requestJson('POST', `${apiBase()}/api/endless/ledger/show`, a);
        return asText(String(r?.text ?? ''));
      }
      case 'ledger_add':
        return asText(await requestJson('POST', `${apiBase()}/api/endless/ledger/add`, a));
      case 'ledger_resolve':
        return asText(await requestJson('POST', `${apiBase()}/api/endless/ledger/resolve`, a));
      case 'ledger_set_title':
        return asText(await requestJson('POST', `${apiBase()}/api/endless/ledger/title`, a));
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
