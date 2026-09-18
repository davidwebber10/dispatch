import { describe, it, expect } from 'vitest';
import { HARNESSES } from '../providers/catalog.js';
import { priceFor, notionalValueUsd } from './pricing.js';
import { MODEL_FOR_TYPE } from '../overseer/prompts.js';
import { OPENCODE_DEFAULT_MODELS } from '../providers/opencode.js';

describe('pricing', () => {
  it('prices a known model per million tokens', () => {
    const v = notionalValueUsd({ model: 'claude-opus-5', input: 1_000_000, output: 0, cacheRead: 0, cacheCreate: 0 })!;
    expect(v).toBeCloseTo(5, 5);
  });

  it('adds every token class', () => {
    const v = notionalValueUsd({ model: 'claude-sonnet-5', input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheCreate: 1_000_000 })!;
    expect(v).toBeCloseTo(3 + 15 + 0.3 + 3.75, 5);
  });

  // An unpriced model must not silently price at zero — the caller has to be able to
  // tell "this cost nothing" from "we do not know what this would have cost".
  it('returns null for an unknown model', () => {
    expect(priceFor('some-future-model')).toBeNull();
    expect(notionalValueUsd({ model: 'some-future-model', input: 999, output: 999, cacheRead: 0, cacheCreate: 0 })).toBeNull();
  });

  it('matches a dated model id by prefix', () => {
    expect(priceFor('claude-haiku-4-5-20251001')).not.toBeNull();
  });

  /*
   * A history import reads OLD transcripts by definition. Dispatch has really run
   * these two — tests/fixtures/claude-stream.jsonl and
   * tests/sessions/token-usage.test.ts — so dropping them would value an imported
   * month at nearly zero, and would also regress routes/state.ts, whose cost chip
   * disappears (AgentDetailHeader.tsx hides a falsy value) when priceFor returns
   * null for a 4-x thread.
   */
  it('prices the prior generation, not just the current one', () => {
    for (const id of ['claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6']) {
      expect(priceFor(id), id).not.toBeNull();
    }
  });

  /*
   * The 1M-context variant is a DIFFERENT id from its base model, and a bare
   * `startsWith` scan would let the base entry swallow it. Exact ids are checked
   * before the prefix scan, and the prefix scan takes the longest match, so an
   * entry for the variant always wins over the shorter base prefix.
   */
  it('resolves each [1m] variant to its own family, not a neighbour', () => {
    // Asserted by VALUE, so a variant wired to the wrong family fails here.
    expect(priceFor('claude-opus-4-8[1m]')?.input).toBe(5);
    expect(priceFor('claude-sonnet-4-6[1m]')?.input).toBe(3);
  });

  it('still resolves an unknown suffix on a known base through the prefix scan', () => {
    expect(priceFor('claude-opus-4-8-20260101')?.input).toBe(5);
    expect(priceFor('claude-haiku-4-5-20251001')?.input).toBe(1);
  });

  /*
   * Reproduces a real billed run from this repo's own fixture, which is where the
   * Opus rates in the table come from. `claude-stream.jsonl`'s result frame reports
   * costUSD 0.2555315 for these token counts, with the cache write being a 1-hour
   * entry (2x input). Our flat table carries the 5-minute rate (1.25x), so the
   * documented under-count is exactly the cache-write term and nothing else.
   */
  it('reproduces the fixture run once the 1h cache write is priced at 2x', () => {
    const p = priceFor('claude-opus-4-8[1m]')!;
    const withOneHourCacheWrite =
      (12865 / 1e6) * p.input
      + (877 / 1e6) * p.output
      + (62823 / 1e6) * p.cacheRead
      + (13787 / 1e6) * (p.input * 2);
    expect(withOneHourCacheWrite).toBeCloseTo(0.2555315, 7);
  });
});

/* ------------------------------------------------------------------------- */

/** Read both the shared picker catalog and daemon-owned OpenCode defaults. */
function spawnableFromHarnesses(): string[] {
  const shared = HARNESSES.flatMap((h) => h.models.map((m) => m.model)).filter((m): m is string => m !== null);
  return [...shared, ...OPENCODE_DEFAULT_MODELS.map((m) => m.model)];
}

/**
 * Models Dispatch can spawn but deliberately does not price. Each one needs a
 * reason, because the alternative — inventing a number — would put a fabricated
 * figure in a headline tile.
 */
const UNPRICED: Record<string, string> = {
  // OpenAI models, run through the Codex CLI. Dispatch has no published price
  // source for them, so their tokens are counted in the token totals but never
  // priced. Add a real entry here the day a source exists — never a guess.
  'gpt-6-astra': 'no published price source in this repo',
  'gpt-5.6-sol': 'no published price source in this repo',
  'gpt-5.6-terra': 'no published price source in this repo',
  'gpt-5.6-luna': 'no published price source in this repo',
  // Grok Pretty threads DO record turns now (grok-translate.ts response_completed
  // frames carry per-call usage), so this model reaches the price table — but the
  // repo's designated price source (the claude-api skill) covers Anthropic models
  // only, and inventing an xAI rate would put a fabricated figure in a headline
  // tile. Its tokens are counted, and the summary marks the value partial.
  'grok-4.5': 'no published price source in this repo; tokens counted, value marked partial',
  // OpenCode threads run OpenRouter models, whose REAL per-turn dollar cost arrives on the
  // wire (ACP usage_update.cost) and rides the result footer as total_cost_usd — a price
  // table here would duplicate a number the provider already reports authoritatively.
  // Most entries use OpenRouter "-latest" aliases, which auto-resolve to the current
  // flagship; the alias string itself never reaches a price table, so every alias needs
  // its own documented exclusion.
  'openrouter/~anthropic/claude-opus-latest': 'real cost arrives via ACP usage_update, not a price table',
  'openrouter/~anthropic/claude-fable-latest': 'real cost arrives via ACP usage_update, not a price table',
  'openrouter/~anthropic/claude-sonnet-latest': 'real cost arrives via ACP usage_update, not a price table',
  'openrouter/~openai/gpt-sol-latest': 'real cost arrives via ACP usage_update, not a price table',
  'openrouter/~openai/gpt-terra-latest': 'real cost arrives via ACP usage_update, not a price table',
  'openrouter/~openai/gpt-luna-latest': 'real cost arrives via ACP usage_update, not a price table',
  'openrouter/~openai/gpt-astra-latest': 'real cost arrives via ACP usage_update, not a price table',
  'openrouter/~google/gemini-pro-latest': 'real cost arrives via ACP usage_update, not a price table',
  'openrouter/~google/gemini-flash-latest': 'real cost arrives via ACP usage_update, not a price table',
  'openrouter/~x-ai/grok-latest': 'real cost arrives via ACP usage_update, not a price table',
  'openrouter/~z-ai/glm-latest': 'real cost arrives via ACP usage_update, not a price table',
  'openrouter/~z-ai/glm-flash-latest': 'real cost arrives via ACP usage_update, not a price table',
  'openrouter/~moonshotai/kimi-latest': 'real cost arrives via ACP usage_update, not a price table',
  'openrouter/~deepseek/deepseek-pro-latest': 'real cost arrives via ACP usage_update, not a price table',
  'openrouter/~deepseek/deepseek-flash-latest': 'real cost arrives via ACP usage_update, not a price table',
  'openrouter/qwen/qwen3.8-max-0902': 'real cost arrives via ACP usage_update, not a price table',
  'openrouter/minimax/minimax-m3': 'real cost arrives via ACP usage_update, not a price table',
  'openrouter/meta-llama/llama-4-maverick': 'real cost arrives via ACP usage_update, not a price table',
  'openrouter/mistralai/mistral-medium-3-5': 'real cost arrives via ACP usage_update, not a price table',
};

describe('every model Dispatch can spawn either prices or is a documented exclusion', () => {
  it('covers the New Thread modal', async () => {
    const spawnable = await spawnableFromHarnesses();
    // Guard the reader: if HARNESSES ever stops carrying real model ids, the
    // loop below would pass vacuously.
    expect(spawnable.length).toBeGreaterThanOrEqual(8);

    const unpriced = spawnable.filter((m) => priceFor(m) === null && !(m in UNPRICED));
    expect(unpriced, `spawnable but unpriced — add a price or a documented exclusion: ${unpriced.join(', ')}`).toEqual([]);
  });

  it('covers the per-agent-type defaults', () => {
    const tiers = Object.values(MODEL_FOR_TYPE);
    expect(tiers.length).toBeGreaterThan(0);
    const unpriced = tiers.filter((m) => priceFor(m) === null && !(m in UNPRICED));
    expect(unpriced, `MODEL_FOR_TYPE tier with no price: ${unpriced.join(', ')}`).toEqual([]);
  });

  it('prices the bare CLI tier aliases a turn can open with', () => {
    // The recorder overwrites these the moment a frame names a real id, but a turn
    // that settles with no usage-bearing frame keeps the alias.
    for (const alias of ['fable', 'opus', 'sonnet', 'haiku']) {
      expect(priceFor(alias), alias).not.toBeNull();
    }
  });
});
