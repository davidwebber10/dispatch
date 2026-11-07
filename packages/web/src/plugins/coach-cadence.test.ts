import { describe, it, expect } from 'vitest';
import { mayShow, emptyCadence, noteShown, dismiss, mute, unmute, isMuted, inQuietHours, LEVEL_CAP } from '../../../plugins/coach/lib/cadence.mjs';
import { withDefaults } from '../../../plugins/coach/lib/settings.mjs';

// Local wall time: the tests build dates from local parts, so quiet hours read the same on any machine.
const local = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m);
const NOW = local(20, 11);
const old = { ...emptyCadence(local(1, 9)) }; // first seen 19 days before NOW: past the first week
const s = (over: Record<string, unknown> = {}) => withDefaults(over);

describe('Coach cadence: mayShow (coach plan Task 10)', () => {
  it('the levels: Off and Quiet show no cards, Normal up to 3 a day, Chatty up to 8', () => {
    expect(LEVEL_CAP).toEqual({ off: 0, quiet: 0, normal: 3, chatty: 8 });
    const shown = (n: number) => ({ ...old, day: '2026-11-20', shownToday: n, shownThisSession: 0 });
    expect(mayShow(shown(0), s({ howOften: 'off' }), NOW, 'card')).toBe(false);
    expect(mayShow(shown(0), s({ howOften: 'quiet' }), NOW, 'card')).toBe(false);
    expect(mayShow(shown(2), s(), NOW, 'card')).toBe(true);
    expect(mayShow(shown(3), s(), NOW, 'card')).toBe(false);
    expect(mayShow(shown(7), s({ howOften: 'chatty', maxPerDay: 8, maxPerSession: 9 }), NOW, 'card')).toBe(true);
    expect(mayShow(shown(8), s({ howOften: 'chatty', maxPerDay: 8, maxPerSession: 9 }), NOW, 'card')).toBe(false);
    // Most cards in a day lowers a level's cap, never raises it.
    expect(mayShow(shown(1), s({ maxPerDay: 1 }), NOW, 'card')).toBe(false);
    expect(mayShow(shown(3), s({ maxPerDay: 20 }), NOW, 'card')).toBe(false);
    // Yesterday's count does not count today.
    expect(mayShow({ ...old, day: '2026-11-19', shownToday: 3 }, s(), NOW, 'card')).toBe(true);
  });

  it('most per session (default 1); a session ends after 2 hours with no card', () => {
    const one = noteShown(old, local(20, 9));
    expect(one).toMatchObject({ day: '2026-11-20', shownToday: 1, shownThisSession: 1 });
    expect(mayShow(one, s(), local(20, 10), 'card')).toBe(false);
    expect(mayShow(one, s(), local(20, 11, 30), 'card')).toBe(true);
    expect(mayShow(one, s({ maxPerSession: 2 }), local(20, 10), 'card')).toBe(true);
    const two = noteShown(one, local(20, 11, 30));
    expect(two).toMatchObject({ shownToday: 2, shownThisSession: 1 });
    expect(noteShown(two, local(21, 9))).toMatchObject({ day: '2026-11-21', shownToday: 1 });
  });

  it('quiet hours, also across midnight', () => {
    const q = s({ quietHours: { from: '18:00', to: '08:00' } });
    expect(inQuietHours({ from: '18:00', to: '08:00' }, local(20, 19))).toBe(true);
    expect(inQuietHours({ from: '18:00', to: '08:00' }, local(20, 7, 59))).toBe(true);
    expect(inQuietHours({ from: '18:00', to: '08:00' }, local(20, 8))).toBe(false);
    expect(inQuietHours({ from: '12:00', to: '13:00' }, local(20, 12, 30))).toBe(true);
    expect(inQuietHours(null, local(20, 3))).toBe(false);
    expect(mayShow(old, q, local(20, 22), 'card')).toBe(false);
    expect(mayShow(old, q, NOW, 'card')).toBe(true);
  });

  it('first week: only the welcome card, once', () => {
    const fresh = emptyCadence(local(18, 9));
    expect(mayShow(fresh, s(), NOW, 'card')).toBe(false);
    expect(mayShow(fresh, s(), NOW, 'card', { welcome: true })).toBe(true);
    expect(mayShow({ ...fresh, welcomeDone: true }, s(), NOW, 'card', { welcome: true })).toBe(false);
    expect(mayShow(old, s(), NOW, 'card', { welcome: true })).toBe(false);
  });

  it('a type that rests is not shown until its rest ends; phone cards follow the phone setting', () => {
    const resting = { ...old, restUntilByType: { 'idle-wait': local(25, 0).toISOString() } };
    expect(mayShow(resting, s(), NOW, 'card', { type: 'idle-wait' })).toBe(false);
    expect(mayShow(resting, s(), NOW, 'card', { type: 'fast-approve' })).toBe(true);
    expect(mayShow(resting, s(), local(26, 9), 'card', { type: 'idle-wait' })).toBe(true);
    expect(mayShow(old, s(), NOW, 'card', { phone: true })).toBe(false);
    expect(mayShow(old, s({ phone: true }), NOW, 'card', { phone: true })).toBe(true);
  });

  it('mayShow is false during a mute and in quiet hours, for the recap too', () => {
    const muted = mute(old, 'hour', NOW);
    expect(isMuted(muted, NOW)).toBe(true);
    expect(mayShow(muted, s(), NOW, 'card')).toBe(false);
    expect(mayShow(muted, s(), NOW, 'recap')).toBe(false);
    expect(mayShow(muted, s(), local(20, 12, 1), 'recap')).toBe(true);
    const q = s({ quietHours: { from: '07:00', to: '09:00' } });
    expect(mayShow(old, q, local(20, 8), 'recap')).toBe(false);
    expect(mayShow(old, q, local(20, 10), 'recap')).toBe(true);
    // Quiet still gets the recap; Off does not; a recap turned off in the app does not show.
    expect(mayShow(old, s({ howOften: 'quiet' }), NOW, 'recap')).toBe(true);
    expect(mayShow(old, s({ howOften: 'off' }), NOW, 'recap')).toBe(false);
    expect(mayShow(old, s({ recap: { inApp: false } }), NOW, 'recap')).toBe(false);
  });

  it('mute for an hour, for today, until turned on; unmute', () => {
    expect(mute(old, 'hour', NOW).mutedUntil).toBe(local(20, 12).toISOString());
    const today = mute(old, 'today', NOW);
    expect(isMuted(today, local(20, 23, 59))).toBe(true);
    expect(isMuted(today, local(21, 0, 1))).toBe(false);
    const forever = mute(old, 'on', NOW);
    expect(isMuted(forever, local(20, 11).getTime() + 400 * 86400_000)).toBe(true);
    expect(isMuted(unmute(forever), NOW)).toBe(false);
  });

  it('✕ only counts: the second dismissal without a reason rests the type 2 weeks; the third offers to turn it off', () => {
    const a = dismiss(old, 'idle-wait', NOW);
    expect(a.state.dismissCount['idle-wait']).toBe(1);
    expect(a.state.restUntilByType['idle-wait']).toBeUndefined();
    expect(a.offerTurnOff).toBe(false);
    const b = dismiss(a.state, 'idle-wait', NOW);
    expect(b.state.restUntilByType['idle-wait']).toBe(new Date(NOW.getTime() + 14 * 86400_000).toISOString());
    expect(b.offerTurnOff).toBe(false);
    const c = dismiss(b.state, 'idle-wait', NOW);
    expect(c.offerTurnOff).toBe(true);
  });
});
