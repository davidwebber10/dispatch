import { describe, it, expect, beforeEach } from 'vitest';
import { useAnalyticsFeed } from './analytics';

describe('analytics feed', () => {
  beforeEach(() => { useAnalyticsFeed.setState({ rev: 0 }); });

  it('bumps the revision when the daemon reports new analytics data', () => {
    useAnalyticsFeed.getState().applyEvent({ type: 'analytics-dirty' });
    useAnalyticsFeed.getState().applyEvent({ type: 'analytics-dirty' });
    expect(useAnalyticsFeed.getState().rev).toBe(2);
  });

  it('ignores every other event, so an open page does not re-fetch on unrelated traffic', () => {
    useAnalyticsFeed.getState().applyEvent({ type: 'terminal:status', terminalId: 't1' });
    useAnalyticsFeed.getState().applyEvent({ type: 'session:created' });
    expect(useAnalyticsFeed.getState().rev).toBe(0);
  });
});
