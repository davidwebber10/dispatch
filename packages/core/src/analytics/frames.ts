/**
 * Pull token usage and tool-call counts out of a structured stream frame.
 *
 * Claude Code emits `{ type:'assistant', message:{ model, content, usage } }` natively,
 * and structured/codex-translate.ts rebuilds Codex frames into the same envelope
 * (see its `usage: { input_tokens, cache_read_input_tokens, output_tokens }` construction).
 * So a single parser covers both providers and analytics needs no per-provider code.
 *
 * Grok and OpenCode Pretty threads also land here: grok-translate.ts stamps their
 * usage-bearing frames into the same envelope (response_completed per call for
 * Grok; the promptResult boundary frame for OpenCode). A thread running as a raw
 * PTY produces no frames here — its usage comes from pty-capture.ts (Claude,
 * Codex) or is honestly absent (legacy Grok PTY threads), which the API reports
 * as "usage not reported", never as zero.
 */

/** Claude Code's placeholder `model` on error/no-op assistant messages. Not a
 *  model: every consumer must treat it as "no model named". Shared so a rename
 *  upstream gets fixed in one place (cc-sessions.ts reads it too). */
export const SYNTHETIC_MODEL = '<synthetic>';

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
  // A context_fill frame (grok-translate.ts usageUpdate) is a GAUGE: its
  // input_tokens is the whole current context, re-reported on every publish so
  // the web can draw the fill bar. It is not a bill, and summing gauge readings
  // recorded every OpenCode turn's context size as input. The billable figure
  // arrives untagged at the turn boundary (promptResult).
  if (ev && typeof ev === 'object' && (ev as Record<string, unknown>).subtype === 'context_fill') return null;
  const msg = message(ev);
  const usage = msg?.usage;
  if (!usage || typeof usage !== 'object') return null;
  // '<synthetic>' is Claude Code's placeholder on error/no-op assistant messages,
  // not a model. Its usage is real and counts; the label is dropped so it can
  // never overwrite the real model another frame named (recorder setModel and
  // pty-claude's tail both take the LAST model seen).
  const model = typeof msg.model === 'string' && msg.model !== SYNTHETIC_MODEL ? msg.model : '';
  return {
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    cacheRead: num(usage.cache_read_input_tokens),
    cacheCreate: num(usage.cache_creation_input_tokens),
    model,
  };
}

export function toolCallsInFrame(ev: unknown): number {
  const content = message(ev)?.content;
  if (!Array.isArray(content)) return 0;
  return content.filter((b) => b && typeof b === 'object' && b.type === 'tool_use').length;
}
