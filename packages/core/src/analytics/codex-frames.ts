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
 * to the whole file if the tail is missing EITHER field — token_count lines are far
 * denser than turn_context lines in real transcripts, so a tail can easily hold a
 * total with no turn_context in it at all. When it widens, the tail's values win
 * wherever it found any (they're newer than anything the full scan can offer);
 * the full scan only fills in what the tail was missing.
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
      let ev: unknown;
      try { ev = JSON.parse(ln); } catch { continue; }
      if (!ev || typeof ev !== 'object') continue;
      const rec = ev as Record<string, unknown>;
      const payload = rec.payload as Record<string, unknown> | undefined;

      if (rec.type === 'turn_context' && payload && typeof payload.model === 'string') {
        out.model = payload.model;
        continue;
      }
      const info = payload && payload.type === 'token_count'
        ? (payload.info as Record<string, unknown> | undefined)
        : undefined;
      const total = info?.total_token_usage as Record<string, unknown> | undefined;
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
  if ((first.totals && first.model) || from === 0) return first;

  // The tail held one but not the other — commonly a total without a turn_context,
  // because token_count lines are far denser than turn_context lines. Re-scan the
  // whole file and fill in only what the tail was missing, so a tail hit is never
  // thrown away. The tail's values are the newer ones wherever both scans found
  // something, so the tail wins.
  const full = scan(0);
  return {
    totals: first.totals ?? full.totals,
    model: first.model || full.model,
  };
}
