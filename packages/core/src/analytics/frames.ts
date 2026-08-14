/**
 * Pull token usage and tool-call counts out of a structured stream frame.
 *
 * Claude Code emits `{ type:'assistant', message:{ model, content, usage } }` natively,
 * and structured/codex-translate.ts rebuilds Codex frames into the same envelope
 * (see its `usage: { input_tokens, cache_read_input_tokens, output_tokens }` construction).
 * So a single parser covers both providers and analytics needs no per-provider code.
 *
 * A provider that never reaches the structured manager at all — Grok, and anything
 * else running as a raw PTY — produces no frames here. Its threads record no turns,
 * which the API reports as "usage not reported", never as zero.
 */

export interface FrameUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  model: string;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function message(ev: unknown): Record<string, any> | null {
  if (!ev || typeof ev !== 'object') return null;
  const msg = (ev as Record<string, any>).message;
  return msg && typeof msg === 'object' ? msg : null;
}

export function usageFromFrame(ev: unknown): FrameUsage | null {
  const msg = message(ev);
  const usage = msg?.usage;
  if (!usage || typeof usage !== 'object') return null;
  return {
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    cacheRead: num(usage.cache_read_input_tokens),
    cacheCreate: num(usage.cache_creation_input_tokens),
    model: typeof msg.model === 'string' ? msg.model : '',
  };
}

export function toolCallsInFrame(ev: unknown): number {
  const content = message(ev)?.content;
  if (!Array.isArray(content)) return 0;
  return content.filter((b) => b && typeof b === 'object' && b.type === 'tool_use').length;
}
