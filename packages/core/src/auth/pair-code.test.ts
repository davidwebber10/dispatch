import { describe, expect, test } from 'vitest';
import { createPairCodes, formatPairCode, looksLikePairCode, normalizePairCode, PAIR_CODE_ALPHABET, PAIR_CODE_TTL_MS } from './pair-code.js';

describe('pair codes', () => {
  test('issue gives XXXX-XXXX from the unambiguous alphabet, and redeem accepts it once', () => {
    const pc = createPairCodes();
    const { code } = pc.issue();
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    for (const c of code.replace('-', '')) expect(PAIR_CODE_ALPHABET).toContain(c);
    expect(pc.active()).toBe(true);
    expect(pc.redeem(code)).toBe(true);
    expect(pc.redeem(code)).toBe(false); // consumed
    expect(pc.active()).toBe(false);
  });

  test('case, dashes and spaces are ignored on redeem', () => {
    const pc = createPairCodes();
    const { code } = pc.issue();
    expect(pc.redeem(code.toLowerCase().replace('-', ' '))).toBe(true);
  });

  test('a wrong code is refused and does not consume the live one', () => {
    const pc = createPairCodes();
    const { code } = pc.issue();
    expect(pc.redeem('AAAA-AAAA')).toBe(false);
    expect(pc.redeem(code.slice(0, 7))).toBe(false);
    expect(pc.redeem(code)).toBe(true);
  });

  test('a code expires after its life, and a new code replaces the old one', () => {
    let t = 1_000_000;
    const pc = createPairCodes({ now: () => t });
    const first = pc.issue();
    expect(first.expiresAt).toBe(t + PAIR_CODE_TTL_MS);
    const second = pc.issue();
    expect(pc.redeem(first.code)).toBe(first.code === second.code); // the old code is dead
    t += PAIR_CODE_TTL_MS;
    expect(pc.active()).toBe(false);
    expect(pc.redeem(second.code)).toBe(false);
  });

  test('redeem with nothing live is false', () => {
    expect(createPairCodes().redeem('ABCD-EFGH')).toBe(false);
  });

  test('helpers: normalize, format, looksLike', () => {
    expect(normalizePairCode(' ab-cd ef_gh ')).toBe('ABCDEFGH');
    expect(formatPairCode('ABCDEFGH')).toBe('ABCD-EFGH');
    expect(looksLikePairCode('abcd-efgh')).toBe(true);
    expect(looksLikePairCode('ABCD-EFG0')).toBe(false); // 0 is not in the alphabet
    expect(looksLikePairCode('x'.repeat(43))).toBe(false); // a token
  });
});
