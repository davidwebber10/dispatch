import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AnalyticsView } from './AnalyticsView';
import { api } from '../../api/client';
import { useAnalyticsFeed } from '../../stores/analytics';

const EMPTY = {
  turns: 0, threads: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
  cacheCreateTokens: 0, totalTokens: 0, notionalUsd: 0, unpricedTokens: 0,
};

function stub(summary = EMPTY, points: any[] = []) {
  vi.spyOn(api, 'analyticsSummary').mockResolvedValue(summary as any);
  vi.spyOn(api, 'analyticsSeries').mockResolvedValue(points as any);
  vi.spyOn(api, 'analyticsTop').mockResolvedValue([] as any);
  vi.spyOn(api, 'analyticsRecords').mockResolvedValue({
    totalTokens: summary.totalTokens, totalTurns: summary.turns, busiestDay: null,
    busiestDayTokens: 0, topModel: null, activeDays: 0, longestTurnSeconds: 0,
  } as any);
  vi.spyOn(api, 'analyticsBackfillState').mockResolvedValue({
    trackingStartedAt: '2026-08-13T00:00:00.000Z', state: 'idle', done: 0, total: 0, lastFinishedAt: null,
  } as any);
}

/** The local day string the query layer produces: date(started_at, 'localtime'). */
function localDay(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() - offsetDays);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * The real `api` client over a fake `fetch`, so a test can read the URL the view
 * actually requested. Returns the list of requested URLs, in order.
 */
function mockFetch(overrides: { summary?: Record<string, unknown>; providers?: string[] } = {}): string[] {
  const calls: string[] = [];
  const json = (data: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => data } as unknown as Response);
  vi.stubGlobal('fetch', vi.fn((input: unknown) => {
    const url = String(input);
    calls.push(url);
    const path = url.split('?')[0];
    if (path === '/api/analytics/summary') return json({ ...EMPTY, turns: 2, threads: 1, totalTokens: 500, ...overrides.summary });
    if (path === '/api/analytics/series') {
      return json(url.includes('groupBy=provider')
        ? (overrides.providers ?? ['codex']).map((key) => ({ day: localDay(), key, value: 500 }))
        : []);
    }
    if (path === '/api/analytics/top') return json([]);
    if (path === '/api/analytics/records') {
      return json({
        totalTokens: 500, totalTurns: 2, busiestDay: null, busiestDayTokens: 0,
        topModel: null, activeDays: 1, longestTurnSeconds: 9,
      });
    }
    if (path === '/api/analytics/backfill') {
      return json({ trackingStartedAt: '2026-08-13T00:00:00.000Z', state: 'idle', done: 0, total: 0, lastFinishedAt: null });
    }
    return json({});
  }));
  return calls;
}

describe('AnalyticsView', () => {
  beforeEach(() => { vi.restoreAllMocks(); useAnalyticsFeed.setState({ rev: 0 }); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('explains an empty table instead of showing zeroes as if they were measured', async () => {
    stub();
    render(<AnalyticsView />);
    await waitFor(() => expect(screen.getByText(/No turns recorded yet/i)).toBeTruthy());
    expect(screen.getByRole('button', { name: /Import history/i })).toBeTruthy();
  });

  it('shows totals once data exists', async () => {
    stub({ ...EMPTY, turns: 12, threads: 3, totalTokens: 1_500_000, outputTokens: 40_000 });
    render(<AnalyticsView />);
    await waitFor(() => expect(screen.getByText('12')).toBeTruthy());
  });

  it('labels the dollar figure as notional, never as cost or spend', async () => {
    stub({ ...EMPTY, turns: 1, notionalUsd: 4.2 });
    render(<AnalyticsView />);
    await waitFor(() => expect(screen.getByText(/equivalent api value/i)).toBeTruthy());
    expect(screen.queryByText(/^cost$/i)).toBeNull();
    expect(screen.queryByText(/spend/i)).toBeNull();
  });

  // unreportedTurns counts turns where no usage frame was ever seen. Those turns
  // really did consume tokens; we never got a count. It must never read as a
  // measured zero.
  it('reports turns that never reported usage, rather than counting them as zero', async () => {
    stub({ ...EMPTY, turns: 10, unreportedTurns: 4, totalTokens: 900 } as any);
    render(<AnalyticsView />);
    await waitFor(() => expect(screen.getByText(/4 turns reported no usage/i)).toBeTruthy());
  });

  it('marks the notional value partial when some model has no price entry', async () => {
    stub({ ...EMPTY, turns: 5, notionalUsd: 1.25, unpricedTokens: 4321 });
    render(<AnalyticsView />);
    await waitFor(() => expect(screen.getByText(/equivalent api value/i)).toBeTruthy());
    const partial = screen.getByText(/partial/i);
    expect(partial).toBeTruthy();
    expect(partial.getAttribute('title') ?? '').toMatch(/no price entry/i);
  });

  // A day with no turns must look different from a quiet day, so the heatmap
  // paints it in the surface colour and gives it no title.
  it('paints an activity calendar where a day with no turns carries no title', async () => {
    vi.spyOn(api, 'analyticsSummary').mockResolvedValue({ ...EMPTY, turns: 6, totalTokens: 5000 } as any);
    vi.spyOn(api, 'analyticsTop').mockResolvedValue([] as any);
    vi.spyOn(api, 'analyticsRecords').mockResolvedValue({
      totalTokens: 5000, totalTurns: 6, busiestDay: localDay(), busiestDayTokens: 5000,
      topModel: 'claude-opus-5', activeDays: 1, longestTurnSeconds: 42,
    } as any);
    vi.spyOn(api, 'analyticsBackfillState').mockResolvedValue({
      trackingStartedAt: '2026-08-13T00:00:00.000Z', state: 'idle', done: 0, total: 0, lastFinishedAt: null,
    } as any);
    vi.spyOn(api, 'analyticsSeries').mockImplementation(async (o: any) => (
      o.metric === 'tokens' && o.groupBy === 'none'
        ? [{ day: localDay(), key: '', value: 5000 }] as any
        : [] as any
    ));

    const { container } = render(<AnalyticsView />);
    await waitFor(() => expect(container.querySelector('[data-day]')).toBeTruthy());
    const busy = container.querySelector(`[data-day="${localDay()}"]`)!;
    const quiet = container.querySelector(`[data-day="${localDay(3)}"]`)!;
    expect(busy.getAttribute('title')).toMatch(/tokens/i);
    expect(quiet.getAttribute('title')).toBe('');
  });

  // jsdom has no layout, so Recharts measures 0x0 and draws no marks. The value
  // of this test is that the chart JSX mounts at all: a bad prop or a missing
  // import would throw here.
  it('mounts the charts when the range holds data', async () => {
    stub(
      { ...EMPTY, turns: 4, threads: 2, totalTokens: 8000, outputTokens: 900 },
      [{ day: localDay(1), key: 'claude-opus-5', value: 5000 }, { day: localDay(), key: 'gpt-5-codex', value: 3000 }],
    );
    const { container } = render(<AnalyticsView />);
    await waitFor(() => expect(container.querySelectorAll('.recharts-responsive-container').length).toBeGreaterThan(0));
  });

  it('offers a provider filter built from the providers present in the data', async () => {
    vi.spyOn(api, 'analyticsSummary').mockResolvedValue({ ...EMPTY, turns: 3, totalTokens: 700 } as any);
    vi.spyOn(api, 'analyticsTop').mockResolvedValue([] as any);
    vi.spyOn(api, 'analyticsRecords').mockResolvedValue({
      totalTokens: 700, totalTurns: 3, busiestDay: null, busiestDayTokens: 0,
      topModel: null, activeDays: 1, longestTurnSeconds: 0,
    } as any);
    vi.spyOn(api, 'analyticsBackfillState').mockResolvedValue({
      trackingStartedAt: '2026-08-13T00:00:00.000Z', state: 'idle', done: 0, total: 0, lastFinishedAt: null,
    } as any);
    vi.spyOn(api, 'analyticsSeries').mockImplementation(async (o: any) => (
      o.groupBy === 'provider'
        ? [{ day: localDay(), key: 'claude-code', value: 700 }] as any
        : [] as any
    ));

    render(<AnalyticsView />);
    const select = await screen.findByLabelText(/provider/i);
    await waitFor(() => expect(select.textContent).toMatch(/claude-code/));
  });

  // The daemon filters by provider itself (routes/analytics.ts reads `provider`
  // and binds it as a SQL parameter), so the filter must reach the wire. A view
  // that filtered client-side would leave the URL unchanged.
  it('sends the provider filter to the daemon on every filtered route', async () => {
    const calls = mockFetch({ providers: ['codex'] });
    render(<AnalyticsView />);

    const select = await screen.findByLabelText(/provider/i);
    await waitFor(() => expect(select.textContent).toMatch(/codex/));
    // Nothing is filtered until the reader asks for it.
    expect(calls.some((u) => u.includes('provider='))).toBe(false);

    // Only requests made AFTER the select moves prove anything. Judging the whole
    // list would pass on the first, unfiltered batch alone.
    const before = calls.length;
    fireEvent.change(select, { target: { value: 'codex' } });

    await waitFor(() => {
      const after = calls.slice(before);
      expect(after.some((u) => u.startsWith('/api/analytics/summary') && u.includes('provider=codex'))).toBe(true);
      expect(after.some((u) => u.startsWith('/api/analytics/series') && u.includes('provider=codex'))).toBe(true);
      expect(after.some((u) => u.startsWith('/api/analytics/top') && u.includes('provider=codex'))).toBe(true);
    });
    // The option list stays unfiltered, or picking one provider would strand the
    // reader with no way back to another.
    const optionRequests = calls.slice(before).filter((u) => u.includes('groupBy=provider'));
    expect(optionRequests.length).toBeGreaterThan(0);
    expect(optionRequests.every((u) => !u.includes('provider=codex'))).toBe(true);
  });

  // A provider whose turns never report usage (a PTY provider such as Grok) must
  // not read as a measured zero once the filter reaches the daemon.
  it('reads as "reported no usage", not zero, when every turn in scope reported nothing', async () => {
    mockFetch({ summary: { turns: 4, threads: 1, totalTokens: 0, outputTokens: 0, unreportedTurns: 4 }, providers: ['grok'] });
    render(<AnalyticsView />);

    await waitFor(() => expect(screen.getByText(/4 turns reported no usage/i)).toBeTruthy());
    const tile = screen.getByText('TOTAL TOKENS').parentElement!;
    expect(tile.textContent).toContain('—');
    expect(tile.textContent).not.toContain('0');
  });

  // The daemon broadcasts `analytics-dirty` when a turn closes; App.tsx fans it
  // out to the store this reads. The page must FOLLOW the work without losing
  // what the reader selected — and with no timer anywhere.
  it('re-fetches when the daemon reports new data, and keeps the reader\'s filters', async () => {
    const calls = mockFetch({ providers: ['codex'] });
    render(<AnalyticsView />);

    const select = await screen.findByLabelText(/provider/i);
    await waitFor(() => expect(select.textContent).toMatch(/codex/));
    fireEvent.change(select, { target: { value: 'codex' } });
    await waitFor(() => expect(calls.some((u) => u.includes('provider=codex'))).toBe(true));

    const before = calls.length;
    act(() => { useAnalyticsFeed.getState().applyEvent({ type: 'analytics-dirty' }); });

    await waitFor(() => {
      const after = calls.slice(before);
      expect(after.some((u) => u.startsWith('/api/analytics/summary') && u.includes('provider=codex'))).toBe(true);
      expect(after.some((u) => u.startsWith('/api/analytics/records'))).toBe(true);
    });
    expect((select as HTMLSelectElement).value).toBe('codex');
    // The colour-domain queries read the whole table. They are deliberately left
    // out of the live refresh: re-pulling them on every closed turn would cost
    // more than it buys, and a domain that never shrinks is the property at stake.
    expect(calls.slice(before).some((u) => u.includes('groupBy=model') && !u.includes('from='))).toBe(false);
  });

  // /api/analytics/records takes no range, so a quiet 30 days must not hide a
  // reader's all-time facts behind an empty state that is only true of the window.
  it('keeps the all-time records visible when the filtered range is empty', async () => {
    stub();
    vi.spyOn(api, 'analyticsRecords').mockResolvedValue({
      totalTokens: 4_000_000, totalTurns: 900, busiestDay: '2026-07-02', busiestDayTokens: 300_000,
      topModel: 'claude-opus-5', activeDays: 40, longestTurnSeconds: 300,
    } as any);

    render(<AnalyticsView />);
    await waitFor(() => expect(screen.getByText(/No turns recorded yet/i)).toBeTruthy());
    expect(screen.getByText(/PERSONAL RECORDS/i)).toBeTruthy();
    expect(screen.getByText('900 turns')).toBeTruthy();
  });

  it('charts turn duration as its own chart, in seconds', async () => {
    stub({ ...EMPTY, turns: 3, totalTokens: 400 }, [{ day: localDay(), key: '', value: 42 }]);
    render(<AnalyticsView />);
    await waitFor(() => expect(screen.getByText(/AVG TURN DURATION · SECONDS/i)).toBeTruthy());
  });
});
