import fs from 'fs';

export interface CodexTotals { input: number; output: number; cached: number }
export interface CodexTail { totals: CodexTotals | null; model: string }

const DEFAULT_TAIL_BYTES = 256 * 1024;

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * Read the newest running total and the newest model from a Codex transcript.
 *
 * Deliberately reads `total_token_usage` and NEVER `last_token_usage`. The latter
 * looks like a per-turn delta and is not: it breaks the delta invariant in 9 of 648
 * real transitions, and summing it overcounts one real file by 767,661 tokens
 * (0.96%). The total is monotonic across those same 648 transitions and survives a
 * /compact, so a diff of totals is the honest per-turn figure.
 *
 * Only the NEWEST of each matters, so a bounded tail read suffices. The window widens
 * to the whole file if the tail holds neither — a quiet turn can be a long way from
 * the last token_count.
 *
 * Envelope shapes, verified against real files under ~/.codex/sessions/:
 *   { type: 'turn_context', payload: { model, ...lots more } }
 *   { type: 'event_msg', payload: { type: 'token_count',
 *       info: { total_token_usage: { input_tokens, cached_input_tokens,
 *                                     output_tokens, reasoning_output_tokens, total_tokens },
 *                last_token_usage: {...}, model_context_window }, rate_limits } }
 */
export function readCodexTail(file: string, tailBytes: number = DEFAULT_TAIL_BYTES): CodexTail | null {
  let size: number;
  try { size = fs.statSync(file).size; } catch { return null; }

  const scan = (from: number): CodexTail => {
    let raw = '';
    try {
      const fd = fs.openSync(file, 'r');
      try {
        const len = size - from;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, from);
        raw = buf.toString('utf-8');
      } finally { fs.closeSync(fd); }
    } catch { return { totals: null, model: '' }; }

    const out: CodexTail = { totals: null, model: '' };
    for (const ln of raw.split('\n')) {
      if (!ln.trim()) continue;
      let ev: any;
      try { ev = JSON.parse(ln); } catch { continue; }

      if (ev?.type === 'turn_context' && typeof ev?.payload?.model === 'string') {
        out.model = ev.payload.model;
        continue;
      }
      const info = ev?.payload?.type === 'token_count' ? ev?.payload?.info : undefined;
      const total = info?.total_token_usage;
      if (total && typeof total === 'object') {
        out.totals = {
          input: num(total.input_tokens),
          cached: num(total.cached_input_tokens),
          output: num(total.output_tokens),
        };
      }
    }
    return out;
  };

  const from = size > tailBytes ? size - tailBytes : 0;
  const first = scan(from);
  if (first.totals || from === 0) return first;
  return scan(0);
}
