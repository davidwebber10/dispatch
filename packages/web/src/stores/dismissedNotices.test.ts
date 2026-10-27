import { describe, it, expect, beforeEach } from 'vitest';
import { useDismissedNotices, dismissKey, noticeHidden, DISMISSED_NOTICES_KEY, DISMISSED_NOTICES_CAP } from './dismissedNotices';

beforeEach(() => { localStorage.clear(); useDismissedNotices.setState({ keys: [] }); });

describe('dismissedNotices store', () => {
  it('dismiss persists to localStorage and isDismissed reads it back, scoped', () => {
    useDismissedNotices.getState().dismiss('t1', 'k1');
    expect(useDismissedNotices.getState().isDismissed('t1', 'k1')).toBe(true);
    expect(useDismissedNotices.getState().isDismissed('t2', 'k1')).toBe(false);
    expect(JSON.parse(localStorage.getItem(DISMISSED_NOTICES_KEY)!)).toEqual([dismissKey('t1', 'k1')]);
  });

  it('dismiss is idempotent and restore removes the key', () => {
    useDismissedNotices.getState().dismiss('t1', 'k1');
    useDismissedNotices.getState().dismiss('t1', 'k1');
    expect(useDismissedNotices.getState().keys).toHaveLength(1);
    useDismissedNotices.getState().restore('t1', 'k1');
    expect(useDismissedNotices.getState().isDismissed('t1', 'k1')).toBe(false);
    expect(JSON.parse(localStorage.getItem(DISMISSED_NOTICES_KEY)!)).toEqual([]);
  });

  it('drops the oldest keys past the cap', () => {
    for (let i = 0; i <= DISMISSED_NOTICES_CAP; i++) useDismissedNotices.getState().dismiss('t', `k${i}`);
    expect(useDismissedNotices.getState().keys).toHaveLength(DISMISSED_NOTICES_CAP);
    expect(useDismissedNotices.getState().isDismissed('t', 'k0')).toBe(false);
    expect(useDismissedNotices.getState().isDismissed('t', `k${DISMISSED_NOTICES_CAP}`)).toBe(true);
  });

  it('noticeHidden is false without a filter or without a key', () => {
    expect(noticeHidden(undefined, 'k')).toBe(false);
    expect(noticeHidden({ scope: 't', keys: [dismissKey('t', 'k')] }, null)).toBe(false);
    expect(noticeHidden({ scope: 't', keys: [dismissKey('t', 'k')] }, 'k')).toBe(true);
  });
});
