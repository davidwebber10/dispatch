import { describe, it, expect } from 'vitest';
import { findQuote, normalizeForMatch, OK_ONLY_ERROR, type QuoteCandidate } from '../../src/overseer/ledger-quote.js';

let nextId = 1;
const msg = (text: string, minute: number, source = 'user'): QuoteCandidate =>
  ({ id: nextId++, text, source, sentAt: `2026-10-05T17:${String(minute).padStart(2, '0')}:00.000Z` });

describe('normalizeForMatch', () => {
  it('lower-cases, collapses white space runs, and trims', () => {
    expect(normalizeForMatch('  A,  but\n\tONLY  ')).toBe('a, but only');
  });
});

describe('findQuote', () => {
  it('ignores case and runs of white space, and stores the user\'s own text', () => {
    const r = findQuote('a, BUT only   for the first store', [msg('N8: A, but only for the first store', 1)], { after: null });
    expect(r).toEqual({ ok: true, messageId: expect.any(Number), sentAt: '2026-10-05T17:01:00.000Z', quote: 'A, but only for the first store' });
  });

  it('counts only messages strictly after the given time', () => {
    const early = msg('use library A', 1);
    expect(findQuote('use library A', [early], { after: '2026-10-05T17:01:00.000Z' })).toEqual({ ok: false, reason: 'not_found' });
    expect(findQuote('use library A', [early], { after: '2026-10-05T17:00:59.000Z' }).ok).toBe(true);
  });

  it('never matches canned, coordinator or daemon messages — including a Direct message relay', () => {
    const r = findQuote('merge it', [
      msg('“merge it” — got it. I\'ll pass it down and close this out.', 1, 'canned'),
      msg('merge it', 2, 'coordinator'),
      msg('💬 The user just sent your agent "X" [agentId a1] a message directly, not through you: "merge it".', 3, 'daemon'),
    ], { after: null });
    expect(r).toEqual({ ok: false, reason: 'not_found' });
  });

  it('picks the earliest matching message', () => {
    const first = msg('ship it', 2);
    const second = msg('ship it', 3);
    const r = findQuote('ship it', [second, first], { after: null });
    expect(r.ok && r.messageId).toBe(first.id);
  });

  it('"ok", "OK.", "okay, " and "k" alone fail as ok_only', () => {
    for (const text of ['ok', 'OK.', 'okay, ', 'k']) {
      expect(findQuote(text, [msg(text, 1)], { after: null }), text).toEqual({ ok: false, reason: 'ok_only' });
    }
    expect(OK_ONLY_ERROR).toBe("An 'ok' at the start of a message is not an answer. Ask the user.");
  });

  it('"ok, merge N12" stores "merge N12"', () => {
    const r = findQuote('ok, merge N12', [msg('ok, merge N12', 1)], { after: null });
    expect(r.ok && r.quote).toBe('merge N12');
  });

  it('removes the ok-word only when the match starts at the beginning of the message', () => {
    const r = findQuote('ok', [msg('fine, ok', 1)], { after: null });
    expect(r.ok && r.quote).toBe('ok'); // an "ok" in the middle of a message is not removed
  });

  it('a word that merely starts with k is not an ok-word', () => {
    const r = findQuote('kick off the import', [msg('kick off the import', 1)], { after: null });
    expect(r.ok && r.quote).toBe('kick off the import');
  });

  it('an empty quote never matches', () => {
    expect(findQuote('   ', [msg('anything', 1)], { after: null })).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('findQuote — word edges', () => {
  const NOT_FOUND = { ok: false, reason: 'not_found' };

  it('a quote that ends inside a word does not match: "N1" is not in "N12: yes"', () => {
    expect(findQuote('N1', [msg('N12: yes', 1)], { after: null })).toEqual(NOT_FOUND);
  });

  it('a quote that starts inside a word does not match: "merge" is not in "emerged"', () => {
    expect(findQuote('merge', [msg('the branches emerged fine', 1)], { after: null })).toEqual(NOT_FOUND);
  });

  it('a quote that ends inside a word does not match: "merge" is not in "merged"', () => {
    expect(findQuote('merge', [msg('already merged', 1)], { after: null })).toEqual(NOT_FOUND);
  });

  it('a later whole-word match still counts after a rejected part-word match', () => {
    const r = findQuote('merge', [msg('emerged, so merge it', 1)], { after: null });
    expect(r.ok && r.quote).toBe('merge');
  });

  it('the edge rule applies on both sides, even when the quote ends in punctuation', () => {
    expect(findQuote('N12:', [msg('N12:yes', 1)], { after: null })).toEqual(NOT_FOUND);
    expect(findQuote(':yes', [msg('N12:yes', 1)], { after: null })).toEqual(NOT_FOUND);
    const r = findQuote('N12:yes', [msg('N12:yes', 1)], { after: null });
    expect(r.ok && r.quote).toBe('N12:yes');
  });

  it('the edge rule reads whole characters, so an astral letter or digit next to a match counts', () => {
    expect(findQuote('merge', [msg('merge\u{1D7D9} now', 1)], { after: null })).toEqual(NOT_FOUND); // 𝟙, a math digit
    expect(findQuote('merge', [msg('\u{1D400}merge now', 1)], { after: null })).toEqual(NOT_FOUND); // 𝐀, a math letter
    const r = findQuote('merge', [msg('\u{1F680} merge now', 1)], { after: null }); // an emoji is not a word character
    expect(r.ok && r.quote).toBe('merge');
  });

  // Word edges are checked first, on the message: "k" in "ok" and "kay" in "okay" are parts of
  // a word, so they fail as not_found (they never reach the ok-word rule).
  it('part of the ok-word is not a quote: "k" from "ok", "kay" from "okay"', () => {
    expect(findQuote('k', [msg('ok', 1)], { after: null })).toEqual(NOT_FOUND);
    expect(findQuote('kay', [msg('okay', 1)], { after: null })).toEqual(NOT_FOUND);
  });

  it('a match that starts inside the leading ok span starts after it; nothing left is ok_only', () => {
    expect(findQuote('ok.', [msg('ok.', 1)], { after: null })).toEqual({ ok: false, reason: 'ok_only' });
    const r = findQuote('ok, merge N12', [msg('ok, merge N12', 1)], { after: null });
    expect(r.ok && r.quote).toBe('merge N12');
    // Inside the span, but at a word edge (after punctuation): it still starts after the span.
    const p = findQuote(', merge N12', [msg('ok,, merge N12', 1)], { after: null });
    expect(p.ok && p.quote).toBe('merge N12');
  });

  it('a match that starts right after the ok-word letters starts inside a word, so it fails', () => {
    expect(findQuote('.', [msg('ok.', 1)], { after: null })).toEqual(NOT_FOUND);
    expect(findQuote(', merge N12', [msg('ok, merge N12', 1)], { after: null })).toEqual(NOT_FOUND);
  });

  it('the ok span is measured on the message, not on the quote', () => {
    // The quote starts with "ok" but the message does not: nothing is removed.
    const r = findQuote('ok then', [msg('ok then', 1)], { after: null });
    expect(r).toEqual({ ok: true, messageId: expect.any(Number), sentAt: expect.any(String), quote: 'then' });
    const mid = findQuote('ok then', [msg('fine, ok then', 1)], { after: null });
    expect(mid.ok && mid.quote).toBe('ok then');
  });

  it('a quote with no letter or digit never counts', () => {
    expect(findQuote('.', [msg('fine.', 1)], { after: null })).toEqual(NOT_FOUND);
    expect(findQuote('!!', [msg('do it!!', 1)], { after: null })).toEqual(NOT_FOUND);
  });

  it('runs of white space in the message match one space in the quote, and the user\'s spacing is stored', () => {
    const r = findQuote('A, but only', [msg('A,\n\n  but   only', 1)], { after: null });
    expect(r.ok && r.quote).toBe('A,\n\n  but   only');
  });
});
