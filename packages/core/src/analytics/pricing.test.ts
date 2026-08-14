import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { priceFor, notionalValueUsd } from './pricing.js';
import { MODEL_FOR_TYPE } from '../overseer/prompts.js';

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

/**
 * Spec section 14 promised "a test that fails on an unpriced model Dispatch can
 * spawn". This is it.
 *
 * The model list is READ FROM THE SOURCE, not copied into this file — a copy
 * would be documentation, not verification, and would never notice a new model
 * being added to the picker.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const NEW_THREAD_MODAL = path.resolve(HERE, '../../../web/src/components/sidebar/NewThreadModal.tsx');

/** Every non-default `model` value in the New Thread modal's harness-aware lists. */
function spawnableFromModal(): string[] {
  const src = fs.readFileSync(NEW_THREAD_MODAL, 'utf-8');
  const start = src.indexOf('const MODELS');
  expect(start, `MODELS list not found in ${NEW_THREAD_MODAL} — re-point this test`).toBeGreaterThan(-1);
  const end = src.indexOf('\n};', start);
  expect(end).toBeGreaterThan(start);
  const block = src.slice(start, end);
  return [...block.matchAll(/model:\s*'([^']+)'/g)].map((m) => m[1]);
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
  'gpt-5.6-sol': 'no published price source in this repo',
  'gpt-5.6-terra': 'no published price source in this repo',
  'gpt-5.6-luna': 'no published price source in this repo',
  // Grok runs as a raw PTY (providers/grok.ts), never reaches the structured
  // manager, and so records no usage_turns row at all (spec section 5). Its model
  // string can therefore never reach the price table.
  'grok-4.5': 'PTY provider — records no turns, so it never reaches pricing',
};

describe('every model Dispatch can spawn either prices or is a documented exclusion', () => {
  it('covers the New Thread modal', () => {
    const spawnable = spawnableFromModal();
    // Guard the reader: if the regex ever stops finding models, the loop below
    // would pass vacuously.
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
