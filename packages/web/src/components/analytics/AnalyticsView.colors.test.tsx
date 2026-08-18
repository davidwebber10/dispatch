import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SERIES } from './chartTheme';

/*
 * jsdom has no layout, so a ResponsiveContainer measures 0x0 and Recharts draws
 * nothing at all. Give the chart an explicit size instead, so this file can read
 * the fill Recharts actually painted — the only place a colour bug is visible.
 */
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    ResponsiveContainer: ({ children, height }: { children: React.ReactElement; height?: number }) =>
      React.cloneElement(children, { width: 600, height: height ?? 240 } as never),
  };
});

const { AnalyticsView } = await import('./AnalyticsView');

const EMPTY = {
  turns: 6, threads: 2, inputTokens: 0, outputTokens: 400, cacheReadTokens: 0,
  cacheCreateTokens: 0, totalTokens: 9000, unreportedTurns: 0,
};

function localDay(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() - offsetDays);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const OPUS = 'claude-opus-5';
const CODEX = 'gpt-5-codex';

/**
 * Two models exist in the table. The daemon returns both until the reader filters
 * to the codex provider, after which the Anthropic rows are gone — exactly what
 * `provider=` does server-side.
 */
function mockFetch() {
  const json = (data: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => data } as unknown as Response);
  vi.stubGlobal('fetch', vi.fn((input: unknown) => {
    const url = String(input);
    const path = url.split('?')[0];
    const filteredToCodex = url.includes('provider=gpt-5-codex') || url.includes('provider=codex');
    if (path === '/api/analytics/summary') return json(EMPTY);
    if (path === '/api/analytics/series') {
      if (url.includes('groupBy=provider')) return json([{ day: localDay(), key: 'codex', value: 9000 }]);
      if (url.includes('groupBy=model')) {
        const models = filteredToCodex ? [CODEX] : [OPUS, CODEX];
        return json(models.map((key) => ({ day: localDay(), key, value: 4500 })));
      }
      return json([]);
    }
    if (path === '/api/analytics/top') return json([]);
    if (path === '/api/analytics/records') {
      return json({
        totalTokens: 9000, totalTurns: 6, busiestDay: null, busiestDayTokens: 0,
        topModel: OPUS, activeDays: 1, longestTurnSeconds: 12,
      });
    }
    if (path === '/api/analytics/backfill') {
      return json({ trackingStartedAt: '2026-08-13T00:00:00.000Z', state: 'idle', done: 0, total: 0, lastFinishedAt: null });
    }
    return json({});
  }));
}

/** The fill Recharts painted on each stacked Bar, in the order the Bars were declared. */
function barFills(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.recharts-bar')]
    .map((g) => g.querySelector('path, rect')?.getAttribute('fill') ?? '');
}

describe('AnalyticsView colour stability', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  /*
   * The hazard makeSeriesScale exists to prevent, one layer up. A colour domain
   * built from FILTERED data shrinks when a filter shrinks: pick one provider,
   * the domain becomes [gpt-5-codex], the scale rebuilds, and the surviving
   * series takes SERIES[0] — a repaint. The domain must come from the whole
   * table, so a survivor keeps the hue it had.
   */
  it('keeps a surviving model on its own colour when a filter hides another', async () => {
    mockFetch();
    const { container } = render(<AnalyticsView />);

    await waitFor(() => expect(barFills(container).length).toBe(2));
    const [opusFill, codexFill] = barFills(container);
    // Sorted domain: claude-opus-5 then gpt-5-codex.
    expect(opusFill).toBe(SERIES[0]);
    expect(codexFill).toBe(SERIES[1]);

    const select = await screen.findByLabelText(/provider/i);
    await waitFor(() => expect(select.textContent).toMatch(/codex/));
    fireEvent.change(select, { target: { value: 'codex' } });

    await waitFor(() => expect(barFills(container).length).toBe(1));
    // The survivor keeps SERIES[1]. A domain rebuilt on the filtered data would
    // hand it SERIES[0] instead.
    expect(barFills(container)[0]).toBe(codexFill);
    expect(barFills(container)[0]).not.toBe(SERIES[0]);
  });
});
