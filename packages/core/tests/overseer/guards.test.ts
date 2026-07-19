import { describe, it, expect } from 'vitest';
import {
  MAX_SPAWN_DEPTH,
  MAX_MESSAGES_PER_PAIR_PER_HOUR,
  checkSpawnDepth,
  PairRateLimiter,
  checkSelfTarget,
  checkArchiveAllowed,
} from '../../src/overseer/guards.js';

describe('checkSpawnDepth', () => {
  it('allows a parent one below the cap', () => {
    expect(checkSpawnDepth(MAX_SPAWN_DEPTH - 1)).toEqual({ ok: true });
  });

  it('refuses a parent exactly at the cap', () => {
    const result = checkSpawnDepth(MAX_SPAWN_DEPTH);
    expect(result.ok).toBe(false);
    expect((result as { ok: false; reason: string }).reason).toContain(String(MAX_SPAWN_DEPTH));
  });

  it('refuses a parent past the cap', () => {
    expect(checkSpawnDepth(MAX_SPAWN_DEPTH + 5).ok).toBe(false);
  });

  it('allows a root thread (depth 0)', () => {
    expect(checkSpawnDepth(0)).toEqual({ ok: true });
  });
});

describe('PairRateLimiter', () => {
  it('allows the 10th message and refuses the 11th', () => {
    const limiter = new PairRateLimiter();
    for (let i = 0; i < MAX_MESSAGES_PER_PAIR_PER_HOUR; i++) {
      expect(limiter.check('a', 'b')).toEqual({ ok: true });
    }
    const eleventh = limiter.check('a', 'b');
    expect(eleventh.ok).toBe(false);
    expect((eleventh as { ok: false; reason: string }).reason).toContain('rate limit');
  });

  it('tracks each (sender, target) pair independently', () => {
    const limiter = new PairRateLimiter();
    for (let i = 0; i < MAX_MESSAGES_PER_PAIR_PER_HOUR; i++) {
      limiter.check('a', 'b');
    }
    // a->b is exhausted, but a->c and d->b are fresh pairs.
    expect(limiter.check('a', 'c')).toEqual({ ok: true });
    expect(limiter.check('d', 'b')).toEqual({ ok: true });
    expect(limiter.check('a', 'b').ok).toBe(false);
  });

  it('rolls the window: an hour later, the pair can message again', () => {
    let now = 0;
    const limiter = new PairRateLimiter({ now: () => now });
    for (let i = 0; i < MAX_MESSAGES_PER_PAIR_PER_HOUR; i++) {
      expect(limiter.check('a', 'b').ok).toBe(true);
    }
    expect(limiter.check('a', 'b').ok).toBe(false); // still within the hour

    now += 60 * 60 * 1000 + 1; // just past an hour later
    expect(limiter.check('a', 'b')).toEqual({ ok: true });
  });

  it('a partially-expired window only frees up the expired slots', () => {
    let now = 0;
    const limiter = new PairRateLimiter({ now: () => now });
    // 5 messages at t=0
    for (let i = 0; i < 5; i++) limiter.check('a', 'b');
    now = 30 * 60 * 1000; // 30 min later
    // 5 more messages at t=30min (total 10, at the cap)
    for (let i = 0; i < 5; i++) limiter.check('a', 'b');
    expect(limiter.check('a', 'b').ok).toBe(false); // 11th, still all 10 within the hour

    now = 61 * 60 * 1000; // the first batch of 5 (at t=0) has now rolled off, the second batch (t=30min) has not
    expect(limiter.check('a', 'b').ok).toBe(true); // room freed up by the expired first batch
  });
});

describe('checkSelfTarget', () => {
  it('refuses when the target is the caller itself, naming the verb', () => {
    const result = checkSelfTarget('thread-1', 'thread-1', 'watch');
    expect(result.ok).toBe(false);
    expect((result as { ok: false; reason: string }).reason).toContain('watch');
  });

  it('names a different verb for a different action', () => {
    const result = checkSelfTarget('thread-1', 'thread-1', 'message');
    expect(result.ok).toBe(false);
    expect((result as { ok: false; reason: string }).reason).toContain('message');
  });

  it('allows targeting a different thread', () => {
    expect(checkSelfTarget('thread-1', 'thread-2', 'complete')).toEqual({ ok: true });
  });

  it('allows when either id is empty (no identity to compare)', () => {
    expect(checkSelfTarget('', 'thread-2', 'watch')).toEqual({ ok: true });
    expect(checkSelfTarget('thread-1', '', 'watch')).toEqual({ ok: true });
  });
});

describe('checkArchiveAllowed', () => {
  it('refuses a role-less (plain) target without force', () => {
    const result = checkArchiveAllowed({ role: null }, false);
    expect(result.ok).toBe(false);
    expect((result as { ok: false; reason: string }).reason).toContain('force');
  });

  it('refuses a role-less target with role undefined without force', () => {
    expect(checkArchiveAllowed({}, false).ok).toBe(false);
  });

  it('allows a role-less target when force is true', () => {
    expect(checkArchiveAllowed({ role: null }, true)).toEqual({ ok: true });
  });

  it('allows a typed agent (role set) without force', () => {
    expect(checkArchiveAllowed({ role: 'agent' }, false)).toEqual({ ok: true });
  });

  it('allows a coordinator (role set) without force', () => {
    expect(checkArchiveAllowed({ role: 'coordinator' }, false)).toEqual({ ok: true });
  });
});
