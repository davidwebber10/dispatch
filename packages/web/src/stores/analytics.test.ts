import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useAnalyticsFeed, COALESCE_MS } from './analytics';

describe('analytics feed', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useAnalyticsFeed.setState({ rev: 0, pending: null });
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  const dirty = () => useAnalyticsFeed.getState().applyEvent({ type: 'analytics-dirty' });
  const rev = () => useAnalyticsFeed.getState().rev;

  it('bumps the revision when the daemon reports new analytics data', () => {
    dirty();
    vi.advanceTimersByTime(COALESCE_MS);
    expect(rev()).toBe(1);
  });

  /*
   * The daemon broadcasts on every closed turn, and each bump costs an open page
   * eleven requests. A burst of agents settling together must cost ONE refresh,
   * not one per agent.
   */
  it('folds a burst of events into a single revision bump', () => {
    for (let i = 0; i < 20; i += 1) dirty();
    // Still inside the window: nothing has fired yet.
    vi.advanceTimersByTime(COALESCE_MS - 1);
    expect(rev()).toBe(0);

    vi.advanceTimersByTime(1);
    expect(rev()).toBe(1);
  });

  it('bumps again for a later burst, so the page keeps following the work', () => {
    dirty();
    vi.advanceTimersByTime(COALESCE_MS);
    expect(rev()).toBe(1);

    dirty();
    vi.advanceTimersByTime(COALESCE_MS);
    expect(rev()).toBe(2);
  });

  /*
   * THE distinction that matters: this is a coalescing window, not a polling
   * timer. With no event, nothing is ever scheduled and the revision never moves,
   * however long the page is left open. A polling implementation would bump here
   * repeatedly and make an idle page issue requests forever.
   */
  it('fires nothing at all when no event arrives', () => {
    vi.advanceTimersByTime(COALESCE_MS * 400);
    expect(rev()).toBe(0);
    expect(useAnalyticsFeed.getState().pending).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves no timer armed once the window has fired', () => {
    dirty();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(COALESCE_MS);
    // Disarmed by firing — the window does not re-arm itself.
    expect(vi.getTimerCount()).toBe(0);
    expect(useAnalyticsFeed.getState().pending).toBeNull();
  });

  it('ignores every other event, so an open page does not re-fetch on unrelated traffic', () => {
    useAnalyticsFeed.getState().applyEvent({ type: 'terminal:status', terminalId: 't1' });
    useAnalyticsFeed.getState().applyEvent({ type: 'session:created' });
    // Not even a window is opened by unrelated traffic.
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(COALESCE_MS * 4);
    expect(rev()).toBe(0);
  });
});
