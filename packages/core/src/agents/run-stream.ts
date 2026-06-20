// Parses the newline-delimited JSON that headless agent runs emit
// (`claude -p --output-format stream-json --verbose`, `codex exec --json`) into a
// provider-agnostic stream of RunEvents, and maps those into RunSteps for the UI.
//
// The parser is deliberately defensive: it line-buffers (so it tolerates being fed
// arbitrary chunks, including splits mid-line, as happens over a PTY), strips a
// trailing CR (PTYs translate \n -> \r\n), and silently skips any line that is not
// valid JSON or is an event type we don't care about. Unknown event shapes never throw.

export type AgentProviderName = 'claude-code' | 'codex';

export interface TodoItem {
  content: string;
  /** 'pending' | 'in_progress' | 'completed' (provider-defined; kept as string). */
  status: string;
  activeForm?: string;
}

export interface RunUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export type RunEvent =
  | { kind: 'init'; model?: string; cwd?: string; sessionId?: string; tools?: string[] }
  | { kind: 'assistant-text'; text: string }
  | { kind: 'thinking' }
  | { kind: 'tool-use'; id?: string; name: string; input: unknown }
  | { kind: 'tool-result'; toolUseId?: string; content: string; isError?: boolean }
  | { kind: 'todos'; todos: TodoItem[] }
  | ({ kind: 'usage' } & RunUsage)
  | {
      kind: 'result';
      isError: boolean;
      result?: string;
      costUsd?: number;
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      numTurns?: number;
      durationMs?: number;
      model?: string;
    };

/**
 * A single item in a run's activity stream. Every RunEvent maps to exactly one
 * RunStep. `timeline` items form the "plan / steps" view; the full set (timeline +
 * activity-only) forms the transcript/activity log.
 */
export interface RunStep {
  kind: RunEvent['kind'];
  title: string;
  detail?: string;
  todos?: TodoItem[];
  status?: 'ok' | 'error';
  /** Shown in the steps timeline (vs. activity-log only). */
  timeline: boolean;
}

export class RunStreamParser {
  private buf = '';

  constructor(private readonly provider: AgentProviderName) {}

  /** Feed a chunk of stdout; returns any RunEvents completed by this chunk. */
  feed(chunk: string): RunEvent[] {
    this.buf += chunk;
    const out: RunEvent[] = [];
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      out.push(...this.parseLine(line));
    }
    return out;
  }

  /** Parse any trailing buffered line (call once the stream ends). */
  flush(): RunEvent[] {
    const line = this.buf;
    this.buf = '';
    return this.parseLine(line);
  }

  private parseLine(raw: string): RunEvent[] {
    const line = raw.replace(/\r$/, '').trim();
    if (!line) return [];
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      return [];
    }
    if (!obj || typeof obj !== 'object') return [];
    return this.provider === 'codex' ? parseCodex(obj) : parseClaude(obj);
  }
}

function parseClaude(o: any): RunEvent[] {
  switch (o.type) {
    case 'system':
      if (o.subtype === 'init') {
        return [{
          kind: 'init',
          model: str(o.model),
          cwd: str(o.cwd),
          sessionId: str(o.session_id),
          tools: Array.isArray(o.tools) ? o.tools.map(String) : undefined,
        }];
      }
      return []; // hook_started/hook_response/thinking_tokens/etc.
    case 'assistant':
      return parseAssistantContent(o?.message);
    case 'user':
      return parseUserContent(o?.message);
    case 'result':
      return [parseResult(o)];
    default:
      return [];
  }
}

function parseAssistantContent(message: any): RunEvent[] {
  if (!message) return [];
  const content = message.content;
  const events: RunEvent[] = [];
  const blocks = Array.isArray(content) ? content : typeof content === 'string' ? [{ type: 'text', text: content }] : [];
  for (const c of blocks) {
    if (!c || typeof c !== 'object') continue;
    if (c.type === 'text') {
      const text = str(c.text);
      if (text && text.trim()) events.push({ kind: 'assistant-text', text });
    } else if (c.type === 'thinking') {
      events.push({ kind: 'thinking' });
    } else if (c.type === 'tool_use') {
      if (c.name === 'TodoWrite' && c.input && Array.isArray(c.input.todos)) {
        events.push({ kind: 'todos', todos: c.input.todos.map(normalizeTodo) });
      } else {
        events.push({ kind: 'tool-use', id: str(c.id), name: str(c.name) ?? 'tool', input: c.input });
      }
    }
  }
  const usage = parseUsage(message.usage);
  if (usage) events.push(usage);
  return events;
}

function parseUserContent(message: any): RunEvent[] {
  if (!message) return [];
  const content = message.content;
  if (!Array.isArray(content)) return [];
  const events: RunEvent[] = [];
  for (const c of content) {
    if (c && c.type === 'tool_result') {
      events.push({
        kind: 'tool-result',
        toolUseId: str(c.tool_use_id),
        content: stringifyContent(c.content),
        isError: c.is_error === true,
      });
    }
  }
  return events;
}

function parseResult(o: any): RunEvent {
  const usage = o.usage ?? {};
  const input = num(usage.input_tokens);
  const output = num(usage.output_tokens);
  return {
    kind: 'result',
    isError: o.is_error === true || (typeof o.subtype === 'string' && o.subtype !== 'success'),
    result: str(o.result),
    costUsd: num(o.total_cost_usd),
    inputTokens: input,
    outputTokens: output,
    totalTokens: input != null || output != null ? (input ?? 0) + (output ?? 0) : undefined,
    numTurns: num(o.num_turns),
    durationMs: num(o.duration_ms),
    model: firstModel(o.modelUsage),
  };
}

function parseUsage(usage: any): (RunEvent & { kind: 'usage' }) | null {
  if (!usage || typeof usage !== 'object') return null;
  const e = {
    kind: 'usage' as const,
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
    cacheReadTokens: num(usage.cache_read_input_tokens),
    cacheCreationTokens: num(usage.cache_creation_input_tokens),
  };
  if (e.inputTokens == null && e.outputTokens == null) return null;
  return e;
}

// --- Codex (codex exec --json) ----------------------------------------------
// Codex emits a thread/turn/item event model:
//   thread.started {thread_id}
//   turn.started
//   item.started / item.completed {item:{type, ...}}   type ∈ command_execution |
//     agent_message | file_change | ...
//   turn.completed {usage:{input_tokens, output_tokens, ...}}
// Codex provides no per-run cost, so costUsd stays undefined for codex runs.
function parseCodex(o: any): RunEvent[] {
  const t: string = o.type ?? o.msg?.type ?? '';

  if (t === 'thread.started' || t === 'session.created' || t === 'init') {
    return [{ kind: 'init', model: str(o.model), cwd: str(o.cwd), sessionId: str(o.thread_id ?? o.session_id ?? o.id) }];
  }

  if (t === 'item.started' || t === 'item.completed') {
    const it = o.item;
    if (!it || typeof it !== 'object') return [];
    const itype = it.type;
    if (itype === 'command_execution') {
      if (t === 'item.started') {
        return [{ kind: 'tool-use', id: str(it.id), name: 'shell', input: it.command }];
      }
      const out = str(it.aggregated_output);
      const isErr = it.status === 'failed' || (typeof it.exit_code === 'number' && it.exit_code !== 0);
      return out ? [{ kind: 'tool-result', toolUseId: str(it.id), content: out, isError: isErr }] : [];
    }
    if (itype === 'agent_message' && t === 'item.completed') {
      const text = str(it.text);
      return text && text.trim() ? [{ kind: 'assistant-text', text }] : [];
    }
    if (itype === 'file_change' && t === 'item.completed') {
      const summary = Array.isArray(it.changes)
        ? it.changes.map((c: any) => `${str(c.kind) ?? 'edit'} ${basename(str(c.path) ?? '')}`).join(', ')
        : '';
      return [{ kind: 'tool-use', id: str(it.id), name: 'file_change', input: { changes: it.changes, summary } }];
    }
    return [];
  }

  if (t === 'turn.completed') {
    const u = o.usage ?? {};
    const input = num(u.input_tokens);
    const output = num(u.output_tokens);
    return [{
      kind: 'result',
      isError: false,
      inputTokens: input,
      outputTokens: output,
      totalTokens: input != null || output != null ? (input ?? 0) + (output ?? 0) : undefined,
    }];
  }

  if (t === 'turn.failed' || t === 'error') {
    return [{ kind: 'result', isError: true, result: str(o.error?.message ?? o.message) }];
  }

  return [];
}

// --- RunEvent -> RunStep -----------------------------------------------------

export function runEventToStep(ev: RunEvent): RunStep {
  switch (ev.kind) {
    case 'init':
      return { kind: 'init', title: 'Started', detail: ev.model ?? undefined, timeline: true };
    case 'assistant-text':
      return { kind: 'assistant-text', title: 'Note', detail: ev.text, timeline: true };
    case 'thinking':
      return { kind: 'thinking', title: 'Thinking…', timeline: false };
    case 'tool-use':
      return { kind: 'tool-use', title: toolTitle(ev.name, ev.input), detail: toolDetail(ev.name, ev.input), timeline: true };
    case 'tool-result':
      return {
        kind: 'tool-result',
        title: ev.isError ? 'Tool error' : 'Tool result',
        detail: truncate(ev.content, 600),
        status: ev.isError ? 'error' : 'ok',
        timeline: false,
      };
    case 'todos':
      return { kind: 'todos', title: 'Plan', todos: ev.todos, timeline: true };
    case 'usage':
      return { kind: 'usage', title: 'Usage', detail: usageDetail(ev), timeline: false };
    case 'result':
      return {
        kind: 'result',
        title: ev.isError ? 'Failed' : 'Completed',
        detail: ev.result,
        status: ev.isError ? 'error' : 'ok',
        timeline: true,
      };
  }
}

function toolTitle(name: string, input: any): string {
  if (name === 'file_change') return 'Edit files';
  if (name === 'shell') return 'Shell';
  const file = input?.file_path ?? input?.path ?? input?.notebook_path;
  if (file) return `${name} ${basename(String(file))}`;
  return name;
}

function toolDetail(name: string, input: any): string | undefined {
  if (input == null) return undefined;
  if (typeof input === 'string') return truncate(input, 300);
  if (name === 'file_change') return str(input.summary);
  if (name === 'Bash') return truncate(str(input.command) ?? '', 300);
  if (input.file_path || input.path) return str(input.file_path ?? input.path);
  if (input.command) return truncate(String(input.command), 300);
  if (input.pattern) return `pattern: ${truncate(String(input.pattern), 200)}`;
  if (input.url) return str(input.url);
  if (input.description) return truncate(String(input.description), 200);
  try {
    return truncate(JSON.stringify(input), 300);
  } catch {
    return undefined;
  }
}

function usageDetail(u: RunUsage): string {
  const parts: string[] = [];
  if (u.inputTokens != null) parts.push(`in ${u.inputTokens.toLocaleString()}`);
  if (u.outputTokens != null) parts.push(`out ${u.outputTokens.toLocaleString()}`);
  return parts.join(' · ');
}

// --- helpers -----------------------------------------------------------------

function normalizeTodo(t: any): TodoItem {
  return { content: str(t?.content) ?? '', status: str(t?.status) ?? 'pending', activeForm: str(t?.activeForm) };
}

function stringifyContent(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === 'string' ? c : c?.type === 'text' ? c.text : c?.text ?? ''))
      .filter(Boolean)
      .join('\n');
  }
  if (content == null) return '';
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function firstModel(modelUsage: any): string | undefined {
  if (!modelUsage || typeof modelUsage !== 'object') return undefined;
  const keys = Object.keys(modelUsage);
  return keys.length ? keys[0] : undefined;
}

function basename(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
