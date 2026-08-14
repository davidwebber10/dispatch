import { describe, it, expect } from 'vitest';
import { priceFor, notionalValueUsd } from './pricing.js';

describe('pricing', () => {
  it('prices a known model per million tokens', () => {
    const v = notionalValueUsd({ model: 'claude-opus-5', input: 1_000_000, output: 0, cacheRead: 0, cacheCreate: 0 })!;
    expect(v).toBeCloseTo(15, 5);
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
});
