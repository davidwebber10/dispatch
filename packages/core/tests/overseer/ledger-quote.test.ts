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
