import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AnalyticsView } from './AnalyticsView';
import { api } from '../../api/client';

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

describe('AnalyticsView', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

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
});
