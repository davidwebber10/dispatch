/**
 * Per-model list prices, in dollars per million tokens.
 *
 * These produce a NOTIONAL figure: on a subscription plan no dollars change hands,
 * so every surface that shows this number must label it "equivalent API value",
 * never "cost" or "spend".
 *
 * ## Where these numbers come from
 *
 * Input and output rates are the published Anthropic list prices, taken from the
 * bundled `claude-api` skill's model table (cached 2026-06-24) — the repo's
 * designated source for model ids and pricing. Cache rates are derived from the
 * published multipliers in the same source: a cache READ costs 0.1x the input
 * rate, and a 5-minute cache WRITE costs 1.25x the input rate.
 *
 * That arithmetic is independently confirmed by this repo's own fixture. In
 * `tests/fixtures/claude-stream.jsonl` a real `claude-opus-4-8[1m]` run reports
 * `costUSD: 0.2555315` for 12865 input / 877 output / 62823 cache-read / 13787
 * cache-create tokens. At $5 / $25 / $0.5 (0.1x) and a 1-hour cache write of $10
 * (2x) that is 0.064325 + 0.021925 + 0.0314115 + 0.13787 = 0.2555315 exactly.
 *
 * ## The one known under-count
 *
 * `usage_turns.cache_create_tokens` sums `cache_creation_input_tokens`, which
 * merges 5-minute and 1-hour cache writes; a flat table can carry only one rate.
 * We use the 5-minute rate (1.25x), so a thread that writes 1-hour cache entries
 * (2x — what the fixture above shows Claude Code doing) is UNDER-valued here.
 * Understating a notional figure is the safe direction: this tile must never
 * claim a larger number than the tokens could actually have been worth.
 *
 * ## Matching
 *
 * An id is matched EXACTLY first, then by the LONGEST matching prefix. Both halves
 * matter:
 *   - Exact-first is what lets `claude-opus-4-8[1m]` carry its own entry without
 *     the plain `claude-opus-4-8` prefix shadowing it.
 *   - Longest-prefix (rather than first-match) means adding a more specific entry
 *     can never be defeated by table order.
 * A dated id (`claude-haiku-4-5-20251001`) still resolves to its family by prefix.
 *
 * An unknown model returns null rather than 0 — "we do not know" and "it was free"
 * are different facts and the UI shows them differently (the `partial` badge).
 */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

/** Build the two cache rates from the input rate, so they can never drift apart. */
const price = (input: number, output: number): ModelPrice => ({
  input,
  output,
  cacheRead: input * 0.1,
  cacheCreate: input * 1.25,
});

const FABLE = price(10, 50);
const OPUS = price(5, 25);
const SONNET = price(3, 15);
const HAIKU = price(1, 5);

/**
 * Prefix entries, family by family. The current generation and the prior one are
 * both here: a history import reads OLD transcripts by definition, so a table that
 * covered only current models would value an imported month at nearly zero. This
 * repo has really seen `claude-opus-4-8` and `claude-sonnet-4-6`
 * (tests/fixtures/claude-stream.jsonl, tests/sessions/token-usage.test.ts).
 */
const PREFIXES: ReadonlyArray<readonly [string, ModelPrice]> = [
  ['claude-fable-5', FABLE],
  ['claude-mythos-5', FABLE],
  ['claude-opus-5', OPUS],
  ['claude-opus-4-8', OPUS],
  ['claude-opus-4-7', OPUS],
  ['claude-opus-4-6', OPUS],
  ['claude-sonnet-5', SONNET],
  ['claude-sonnet-4-6', SONNET],
  ['claude-haiku-4-5', HAIKU],
];

/**
 * Exact ids, checked before the prefix scan.
 *
 * **The tier aliases.** A thread opens with `terminal.config.model`, which is a
 * bare CLI alias (`overseer/prompts.ts` MODEL_FOR_TYPE, and the New Thread modal's
 * model select). The recorder replaces it the moment a frame names a real id, but a
 * turn that settles without a usage-bearing frame keeps the alias, and it must
 * still price. Each alias resolves to the model the CLI resolves it to today.
 *
 * **The long-context variants.** `claude-opus-4-8[1m]` is a distinct id, and it is
 * listed explicitly so a future divergence from the base rate cannot be silently
 * swallowed by the `claude-opus-4-8` prefix. Today it carries the base rate,
 * because that is what the repo's own fixture bills it at (see the header).
 */
const EXACT: ReadonlyMap<string, ModelPrice> = new Map([
  ['fable', FABLE],
  ['opus', OPUS],
  ['sonnet', SONNET],
  ['haiku', HAIKU],
  ['claude-opus-5[1m]', OPUS],
  ['claude-opus-4-8[1m]', OPUS],
  ['claude-opus-4-7[1m]', OPUS],
  ['claude-sonnet-5[1m]', SONNET],
  ['claude-sonnet-4-6[1m]', SONNET],
]);

export function priceFor(model: string): ModelPrice | null {
  if (!model) return null;
  const exact = EXACT.get(model);
  if (exact) return exact;

  let best: ModelPrice | null = null;
  let bestLength = -1;
  for (const [prefix, p] of PREFIXES) {
    if (model.startsWith(prefix) && prefix.length > bestLength) {
      best = p;
      bestLength = prefix.length;
    }
  }
  return best;
}

export function notionalValueUsd(t: {
  model: string; input: number; output: number; cacheRead: number; cacheCreate: number;
}): number | null {
  const p = priceFor(t.model);
  if (!p) return null;
  return (t.input / 1e6) * p.input
       + (t.output / 1e6) * p.output
       + (t.cacheRead / 1e6) * p.cacheRead
       + (t.cacheCreate / 1e6) * p.cacheCreate;
}
