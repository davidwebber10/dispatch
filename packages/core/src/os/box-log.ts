// packages/core/src/os/box-log.ts
// One-line JSON log lines on stdout for a HOSTED box, so the box log (the container's stdout) says
// which step of a sign-in, a start or a thread went wrong. A local install writes none of them.
//
// Never logged: a code, a token, a cookie, the content of a credential file, a prompt, a URL query.
// Every string field goes through `redactLogText` first, so a caller that passes the CLI's own error
// text cannot leak a code or a token that the text happens to carry.
import { isHostedBox } from './hosted-mode.js';

export type BoxLogFields = Record<string, unknown>;

const MAX_TEXT = 300;

/**
 * Remove anything that looks like a secret from a text: URL queries and fragments, `code#state`
 * pairs, known token shapes, `key=value` secrets, e-mail addresses, and long opaque runs (a code or
 * a token with no known prefix). Then cut it to `max` characters.
 */
export function redactLogText(text: string, max = MAX_TEXT): string {
  let s = String(text);
  // A URL keeps its scheme, host and path; its query and fragment go.
  s = s.replace(/\b(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/gi, '$1?[redacted]');
  // A pasted `code#state`.
  s = s.replace(/[A-Za-z0-9_\-.~]{6,}#[A-Za-z0-9_\-.~]{6,}/g, '[redacted]');
  // Known token shapes.
  s = s.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[redacted]');
  s = s.replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]');
  s = s.replace(/\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)*/g, '[redacted]');
  // key=value / key: value secrets.
  s = s.replace(/\b(code|state|token|access_token|refresh_token|secret|password|passwd|api[_-]?key|cookie|authorization)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&,;]+)/gi, '$1$2[redacted]');
  // E-mail addresses.
  s = s.replace(/[^\s@<>"']+@[^\s@<>"']+\.[A-Za-z]{2,}/g, '[email]');
  // Long opaque runs (a code or a token with no known prefix).
  s = s.replace(/[A-Za-z0-9_\-+=]{24,}/g, '[redacted]');
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** A thread, project, session or Inbox drop id: a UUID is an identifier, not a secret, and the log must name its thread. */
const ID_KEYS = new Set(['thread', 'terminal', 'terminalId', 'session', 'sessionId', 'project', 'drop']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An MCP tool name (`mcp__<server>__<tool>`) in a list of tools or names: kept, so a warning names the tool. */
const NAME_KEYS = new Set(['tools', 'unexpected']);
const MCP_TOOL = /^mcp__[A-Za-z0-9_-]{1,64}__[A-Za-z0-9_-]{1,64}$/;

function clean(v: unknown, depth = 0, key?: string): unknown {
  if (typeof v === 'string' && key !== undefined && ID_KEYS.has(key) && UUID.test(v)) return v;
  if (typeof v === 'string' && key !== undefined && NAME_KEYS.has(key) && MCP_TOOL.test(v)) return v;
  if (typeof v === 'string') return redactLogText(v);
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return v;
  if (Array.isArray(v)) return depth > 2 ? '[list]' : v.slice(0, 50).map((x) => clean(x, depth + 1, key));
  if (v && typeof v === 'object') {
    if (depth > 2) return '[object]';
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = clean(x, depth + 1, k);
    return out;
  }
  return undefined;
}

let sink: (line: string) => void = (line) => { try { process.stdout.write(`${line}\n`); } catch { /* stdout closed */ } };
let enabled: () => boolean = () => isHostedBox(process.env);

/** One structured line. Hosted only; never throws. `level` is info unless the fields say otherwise. */
export function boxLog(event: string, fields: BoxLogFields = {}, level: 'info' | 'warn' | 'error' = 'info'): void {
  try {
    if (!enabled()) return;
    const body = clean(fields) as Record<string, unknown>;
    sink(JSON.stringify({ ts: new Date().toISOString(), level, src: 'dispatch', event, ...body }));
  } catch { /* logging never breaks the daemon */ }
}

/** Test seam: capture the lines and force the switch. Pass nothing to restore the defaults. */
export function setBoxLogForTest(o?: { sink?: (line: string) => void; enabled?: boolean }): void {
  sink = o?.sink ?? ((line) => { try { process.stdout.write(`${line}\n`); } catch { /* stdout closed */ } });
  enabled = o?.enabled === undefined ? () => isHostedBox(process.env) : () => o.enabled!;
}
