import fs from 'fs';

export interface CodexTotals { input: number; output: number; cached: number }
export interface CodexTail { totals: CodexTotals | null; model: string }

const DEFAULT_TAIL_BYTES = 256 * 1024;

/**
 * The hard ceiling on how far back the widen may reach. Same value as
 * `MAX_BACKFILL_BYTES` in sessions/cc-sessions.ts, which draws the same line for
 * the same reason: a transcript can be arbitrarily large, and a synchronous read
 * of one must not be allowed to grow with it.
 */
const MAX_WIDEN_BYTES = 16 * 1024 * 1024;

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
 * in doubling steps if the tail is missing EITHER field — token_count lines are far
 * denser than turn_context lines in real transcripts, so a tail can easily hold a
 * total with no turn_context in it at all. A wider scan's values only fill in what a
 * narrower one was missing; wherever both found something the narrower (newer) one
 * wins.
 *
 * The widen STOPS at MAX_WIDEN_BYTES, and that bound is the point. This runs inside
 * StatusService.apply(), on every Codex PTY turn end. Measured against this machine's
 * real ~/.codex/sessions: 269 of 441 transcripts (61%) hold no turn_context within a
 * 256 KiB tail, 146 of those exceed 5 MB, and the largest is 152 MB — inside which
 * 78% of token_count positions have no turn_context in a 256 KiB tail. Reading one
 * whole measured 316 ms of synchronous block and pushed RSS to about 512 MB, on the
 * status path.
 *
 * So the cap trades model attribution for latency, deliberately. The TOTAL is what
 * drives correctness and it is almost always in the tail; only the model is at stake
 * beyond the cap. A row that reports `model: ''` occasionally is a far better outcome
 * than a third of a second of block and half a gigabyte of allocation on every turn
 * end of a long thread.
 *
 * Envelope shapes, verified against real files under ~/.codex/sessions/:
 *   { type: 'turn_context', payload: { model, ...lots more } }
 *   { type: 'event_msg', payload: { type: 'token_count',
 *       info: { total_token_usage: { input_tokens, cached_input_tokens,
 *                                     output_tokens, reasoning_output_tokens, total_tokens },
 *                last_token_usage: {...}, model_context_window }, rate_limits } }
 */
export function readCodexTail(
  file: string,
  tailBytes: number = DEFAULT_TAIL_BYTES,
  maxBytes: number = MAX_WIDEN_BYTES,
): CodexTail | null {
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

  let window = tailBytes;
  let from = size > window ? size - window : 0;
  let out = scan(from);

  // Widen by doubling while something is still missing, we have not reached the
  // start of the file, and we are still under the cap. Each step fills in only what
  // the narrower (newer) scans did not find, so a tail hit is never thrown away.
  // Reaching the cap without a turn_context is an accepted outcome, not a failure:
  // the totals stand and the model stays ''.
  while (!(out.totals && out.model) && from > 0 && window < maxBytes) {
    window = Math.min(window * 2, maxBytes);
    from = size > window ? size - window : 0;
    const wider = scan(from);
    out = { totals: out.totals ?? wider.totals, model: out.model || wider.model };
  }
  return out;
}
