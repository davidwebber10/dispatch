import { describe, it, expect } from 'vitest';
import { pendingAsk } from './threadAsk';

// Fixtures kept minimal — pendingAsk only reads status/threadStatus/activity off the live entry
// and status/config off the row.
const declaredOutcome = { config: { lastOutcome: { summary: 'Which auth flow — OAuth or PAT?', needsHelp: true, inferred: false } } };
const inferredOutcome = { config: { lastOutcome: { summary: 'Should I proceed?', needsHelp: true, inferred: true } } };
const doneOutcome = { config: { lastOutcome: { summary: 'shipped v2.9.0', needsHelp: false, inferred: false } } };

describe('pendingAsk — live status is authoritative when present', () => {
  it('surfaces a declared ask from the live activity', () => {
    expect(pendingAsk({ threadStatus: 'needs_input', activity: 'Which port should the proxy bind?' }, undefined))
      .toBe('Which port should the proxy bind?');
  });

  it('uses the coarse `status` field too (some events only carry that)', () => {
    expect(pendingAsk({ status: 'needs_input', activity: 'Delete the stale branch?' }, undefined))
      .toBe('Delete the stale branch?');
  });

  it('returns null for an inferred ask — its text is already in the transcript', () => {
    // The server labels an inferred ask with this exact generic string.
    expect(pendingAsk({ threadStatus: 'needs_input', activity: 'Asked a question' }, declaredOutcome as any))
      .toBeNull();
  });

  it('returns null when the thread is live-working, even if the persisted row still says needs_input', () => {
    // This is the anti-stale guarantee: the human already answered, live says working, so no
    // banner — regardless of a lagging persisted row/outcome.
    expect(pendingAsk({ threadStatus: 'working', activity: 'Editing files' }, { status: 'needs_input', ...declaredOutcome } as any))
      .toBeNull();
  });

  it('returns null when waiting but no ask text has arrived yet', () => {
    expect(pendingAsk({ threadStatus: 'needs_input', activity: null } as any, declaredOutcome as any)).toBeNull();
    expect(pendingAsk({ threadStatus: 'needs_input' }, declaredOutcome as any)).toBeNull();
  });
});

describe('pendingAsk — persisted fallback when no live status (fresh load / reconnect)', () => {
  it('surfaces a declared needs-help outcome from the persisted row', () => {
    expect(pendingAsk(undefined, { status: 'needs_input', ...declaredOutcome } as any))
      .toBe('Which auth flow — OAuth or PAT?');
  });

  it('returns null for an inferred outcome (already visible in the transcript)', () => {
    expect(pendingAsk(undefined, { status: 'needs_input', ...inferredOutcome } as any)).toBeNull();
  });

  it('returns null for a finished (done) outcome', () => {
    expect(pendingAsk(undefined, { status: 'needs_input', ...doneOutcome } as any)).toBeNull();
  });

  it('returns null when the persisted row is not waiting', () => {
    expect(pendingAsk(undefined, { status: 'idle', ...declaredOutcome } as any)).toBeNull();
  });

  it('returns null when there is no outcome at all', () => {
    expect(pendingAsk(undefined, { status: 'needs_input', config: {} } as any)).toBeNull();
    expect(pendingAsk(undefined, undefined)).toBeNull();
  });

  it('does not fall back to persisted while a live entry exists (live wins, even if empty)', () => {
    // A live entry that is needs_input with no activity must NOT reach the persisted declared
    // outcome — otherwise the live-authoritative rule leaks.
    expect(pendingAsk({ threadStatus: 'needs_input' }, { status: 'needs_input', ...declaredOutcome } as any)).toBeNull();
  });
});
