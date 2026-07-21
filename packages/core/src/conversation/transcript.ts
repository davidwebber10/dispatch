/**
 * Parses Claude Code's interactive session transcript JSONL
 * (~/.claude/projects/<enc-cwd>/<sessionId>.jsonl) into a flat conversation for
 * Normal Mode. Each line is an independent JSON entry; we keep the human prompts,
 * assistant text/thinking, tool calls and tool results, and skip the bookkeeping
 * entries (mode/permission-mode/attachment/file-history-snapshot, isMeta users).
 */

import { classifyUserText } from './task-notification.js';

export interface ConvItem {
  /** 'notice' — a system-injected event Claude Code writes as a `user` line but which is not
   *  the human speaking (today: background-task completions, see task-notification.ts). The
   *  View renders it as a muted inline row, never a user bubble; `text` is the summary only. */
  kind: 'user' | 'assistant' | 'thinking' | 'tool' | 'tool-result' | 'notice';
  text?: string;
  toolName?: string;
  toolTitle?: string;
  toolDetail?: string;
  isError?: boolean;
  ts?: string;
  uuid?: string;
  line?: number;       // source JSONL line index (set by the caller; enables jump-to)
  toolInput?: string;  // the tool call's raw arguments (pretty JSON), for the Input tab
  toolFile?: string;   // file path argument, for output-language inference
  /** Who sent a 'user'-kind item — set by the caller (SessionService.getConversation) from
   *  the durable message_source table, since the raw transcript line itself has no such
   *  field (see db/message-source.ts). Undefined for untagged/legacy turns — renders as a
   *  plain "You" bubble, same as today. */
  source?: 'user' | 'coordinator';
}

export function parseClaudeTranscript(text: string): ConvItem[] {
  const items: ConvItem[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: any;
    try { obj = JSON.parse(trimmed); } catch { continue; } // partial/garbled line
    items.push(...parseEntry(obj));
  }
  return items;
}

function parseEntry(o: any): ConvItem[] {
  if (!o || typeof o !== 'object') return [];
  const ts = str(o.timestamp);
  const uuid = str(o.uuid);
  const msg = o.message;

  if (o.type === 'user' && msg) {
    if (o.isMeta) return []; // injected context / system reminders
    const c = msg.content;
    if (typeof c === 'string') {
      if (!c.trim()) return [];
      const it = userOrNotice(c, ts, uuid);
      return it ? [it] : [];
    }
    if (Array.isArray(c)) {
      const out: ConvItem[] = [];
      for (const b of c) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          const it = userOrNotice(b.text, ts, uuid);
          if (it) out.push(it);
        } else if (b.type === 'tool_result') {
          out.push({ kind: 'tool-result', text: stringifyContent(b.content), isError: b.is_error === true, ts, uuid });
        }
      }
      return out;
    }
    return [];
  }

  if (o.type === 'assistant' && msg && Array.isArray(msg.content)) {
    const out: ConvItem[] = [];
    for (const b of msg.content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        out.push({ kind: 'assistant', text: b.text, ts, uuid });
      } else if (b.type === 'thinking') {
        out.push({ kind: 'thinking', text: str(b.thinking), ts, uuid });
      } else if (b.type === 'tool_use') {
        const name = str(b.name) ?? 'tool';
        const file = b.input?.file_path ?? b.input?.path ?? b.input?.notebook_path;
        out.push({
          kind: 'tool', toolName: name, toolTitle: toolTitle(name, b.input), toolDetail: toolDetail(name, b.input),
          toolInput: toolInputString(name, b.input), toolFile: file ? String(file) : undefined, ts, uuid,
        });
      }
    }
    return out;
  }

  return [];
}

/**
 * Classify one `user`-role text body (see classifyUserText). Claude Code writes two kinds of
 * non-human turn on this same line type with no `isMeta` flag for the guard above to catch:
 * background-task completions (`<task-notification>`) and slash-command echoes (e.g.
 * `<local-command-stdout>Compacted</local-command-stdout>`). Both would otherwise render as a
 * user bubble full of raw XML. A task notification and a command echo with output are demoted
 * to a muted 'notice' (the notification is what CAUSES the assistant's next action; a `/compact`
 * echo is a useful "this happened here" marker); a contentless echo is dropped → null.
 */
function userOrNotice(text: string, ts?: string, uuid?: string): ConvItem | null {
  const c = classifyUserText(text);
  if (c.kind === 'drop') return null;
  if (c.kind === 'notice') return { kind: 'notice', text: c.text, ts, uuid };
  return { kind: 'user', text, ts, uuid };
}

function toolTitle(name: string, input: any): string {
  if (name === 'TodoWrite') return 'Updated plan';
  const file = input?.file_path ?? input?.path ?? input?.notebook_path;
  if (file) return `${name} ${basename(String(file))}`;
  return name;
}

function toolDetail(name: string, input: any): string | undefined {
  if (input == null) return undefined;
  if (typeof input === 'string') return truncate(input, 240);
  if (name === 'Bash') return truncate(str(input.command) ?? '', 240);
  if (input.file_path || input.path) return str(input.file_path ?? input.path);
  if (input.pattern) return `pattern: ${truncate(String(input.pattern), 160)}`;
  if (input.url) return str(input.url);
  if (input.description) return truncate(String(input.description), 160);
  try { return truncate(JSON.stringify(input), 240); } catch { return undefined; }
}

// The tool call's arguments, for the Input tab. Bash shows the bare command;
// everything else shows pretty-printed JSON.
function toolInputString(name: string, input: any): string | undefined {
  if (input == null) return undefined;
  if (typeof input === 'string') return input;
  if (name === 'Bash' && typeof input.command === 'string') return input.command;
  try { return JSON.stringify(input, null, 2); } catch { return String(input); }
}

function stringifyContent(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c === 'string' ? c : c?.type === 'text' ? c.text : c?.text ?? '')).filter(Boolean).join('\n');
  }
  if (content == null) return '';
  try { return JSON.stringify(content); } catch { return String(content); }
}

function basename(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}
function truncate(s: string, n: number): string { return s.length <= n ? s : s.slice(0, n - 1) + '…'; }
function str(v: unknown): string | undefined { return typeof v === 'string' ? v : undefined; }
