import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within, act } from '@testing-library/react';
import { UsageRings } from './UsageRings';
import { ringModels, ringTone } from './usageGauge';

const now = Date.UTC(2026, 10, 5, 20);
const H = 3600_000;
const summary = (over: Record<string, unknown> = {}) => ({
  warnPercent: 80, paused: [],
  providers: [
    { provider: 'claude-code', asOf: now, windows: {
      five_hour: { usedPercent: 82, resetsAt: now + 3 * H, forecast: { runsOutAt: now + H, lastsUntilReset: false, basisHours: 2 } },
      seven_day: { usedPercent: 21, resetsAt: now + 60 * H, forecast: { runsOutAt: null, lastsUntilReset: true, basisHours: 24 } },
    } },
    { provider: 'codex', asOf: now, windows: { seven_day: { usedPercent: 4, resetsAt: now + 90 * H } } },
  ],
  ...over,
}) as never;

describe('usage rings', () => {
  it('green, then yellow 30 points before the warning, then red at it', () => {
    expect(ringTone(49, 80)).toBe('green');
    expect(ringTone(50, 80)).toBe('yellow');
    expect(ringTone(80, 80)).toBe('red');
  });

  it('one ring per tool, showing what is left of its closest-to-empty limit', () => {
    const [claude, codex] = ringModels(summary(), now);
    expect(claude.main).toMatchObject({ type: 'five_hour', left: 18, tone: 'red' });
    expect(codex.main).toMatchObject({ type: 'seven_day', left: 96, tone: 'green' });
  });

  it('shows every limit with its reset and the run-out estimate, marked as an estimate', () => {
    render(<UsageRings summary={summary()} now={now} />);
    const claude = screen.getByRole('region', { name: 'Claude' });
    // One bar per limit, in a steady order (5-hour, then weekly), each with how much is used.
    const bars = within(claude).getAllByRole('meter');
    expect(bars.map((b) => b.getAttribute('aria-label'))).toEqual(['Claude 5-hour: 82% used', 'Claude weekly: 21% used']);
    expect(bars.map((b) => b.getAttribute('aria-valuenow'))).toEqual(['82', '21']);
    // Short on the row, marked EST; the pace it is based on is in the tooltip.
    expect(claude.textContent).toContain('out ~');
    expect(claude.textContent).toContain('EST');
    expect(claude.textContent).toContain('lasts to reset');
    expect(claude.querySelector('[title^="At the last 2 h pace it runs out around"]')).not.toBeNull();
    expect(within(screen.getByRole('region', { name: 'Codex' })).getByRole('meter').getAttribute('aria-label')).toBe('Codex weekly: 4% used');
    expect(claude.textContent).toContain('Resets'); // the reset line, capitalised under its bar
  });

  // The chip turns red for a paused tool with no figures (#131), so its sheet must still name the pause.
  it('a pause with no figures still shows its line under "No figures reported yet"', () => {
    const paused = { provider: 'codex', kind: 'session', earliestResetsAt: now + H, threads: 2, capped: 0, chat: false, firstTerminalId: 't', firstSessionId: 's', episodeStartedAt: now - H, latestStartedAt: now - H, activeUntil: now + H };
    render(<UsageRings summary={summary({ providers: [], paused: [paused] })} now={now} />);
    const sheet = screen.getByTestId('usage-rings');
    expect(sheet.textContent).toContain('No figures reported yet');
    expect(sheet.textContent).toContain('Codex agents paused: session limit');
  });

  it('a tool with no current figure gets no ring', () => {
    const s = summary({ providers: [{ provider: 'codex', asOf: now, windows: { seven_day: { usedPercent: null, resetsAt: now + H } } }] });
    render(<UsageRings summary={s} now={now} />);
    expect(screen.getByText('No figures reported yet')).toBeInTheDocument();
  });

  it('banked resets show on the card with their expiries, and Use links to the ChatGPT usage page (2026-11-06)', () => {
    const s = summary();
    (s as any).providers[1].resetCredits = { available: 3, nextExpiresAt: now + 20 * H, credits: [
      { id: 'soon', expiresAt: now + 20 * H, title: 'Full reset' },
      { id: 'later', expiresAt: now + 30 * 24 * H, title: 'Full reset' },
    ] };
    render(<UsageRings summary={s} now={now} />);
    const codex = screen.getByRole('region', { name: 'Codex' });
    // Every reset's expiry is listed; one inside 48 hours is marked.
    const expiries = within(codex).getByTestId('reset-expiries');
    expect(expiries.textContent).toMatch(/^Expire (today|tomorrow) .+ · \w{3} \d{1,2}$/);
    expect(codex.textContent).toContain('3resets banked');
    // Codex's app-server answers "nothingToReset" to the in-app spend until a limit is hit, so the
    // reset is used on ChatGPT's own usage page.
    const use = within(codex).getByRole('link', { name: 'Use a reset on the Codex usage page' });
    expect(use).toHaveAttribute('href', 'https://chatgpt.com/settings/usage?tab=overview');
    expect(use).toHaveAttribute('target', '_blank');
    expect(screen.queryByRole('button', { name: 'Use one' })).toBeNull();
  });

  it('Claude limit resets (the Fable launch resets) show on the Claude card; Use opens claude.ai, and equal expiries are counted once (2026-11-09)', () => {
    const s = summary();
    const end = now + 120 * 24 * H;
    (s as any).providers[0].resetCredits = { available: 3, nextExpiresAt: end, credits: ['a', 'b', 'c'].map((id) => ({ id, expiresAt: end, title: 'New model launch: Fable reset' })) };
    render(<UsageRings summary={s} now={now} />);
    const card = screen.getByRole('region', { name: 'Claude' });
    expect(card.textContent).toContain('3resets banked');
    expect(within(card).getByTestId('reset-expiries').textContent).toMatch(/^Expire \w{3} \d{1,2} ×3$/);
    expect(within(card).getByRole('link', { name: 'Use a reset on the Claude usage page' })).toHaveAttribute('href', 'https://claude.ai/settings/usage');
  });

  // The count-up reads performance.now() and the frame time. Under jsdom those are two clocks with
  // different origins, so on a slow CI runner the count sat at 0 for longer than waitFor waits.
  // Faking both on one clock makes the test step through the animation by hand.
  it('the numbers count up to their figures when the sheet opens, and the bar fills to match', () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
    try {
      render(<UsageRings summary={summary()} now={now} />);
      const claude = screen.getByRole('region', { name: 'Claude' });
      const shown = () => [...claude.textContent!.matchAll(/(\d+)% used/g)].map((m) => Number(m[1]));
      // The fill is the bar's one child that is not a threshold mark.
      const fill = () => within(claude).getAllByRole('meter')[0].querySelector<HTMLElement>(':scope > div:not([aria-hidden])')?.style.width;
      expect(shown()).toEqual([0, 0]); // starts from 0
      expect(fill()).toBeUndefined(); // no fill yet
      act(() => { vi.advanceTimersByTime(200); });
      const [five, week] = shown();
      expect(five).toBeGreaterThan(0);
      expect(five).toBeLessThan(82);
      expect(week).toBeLessThan(21);
      act(() => { vi.advanceTimersByTime(1000); });
      expect(shown()).toEqual([82, 21]);
      expect(fill()).toBe('82%');
    } finally {
      vi.useRealTimers();
    }
  });

  it('the warning level is marked on each bar: yellow 30 points before it, red at it', () => {
    render(<UsageRings summary={summary()} now={now} />);
    const bar = within(screen.getByRole('region', { name: 'Codex' })).getByRole('meter');
    const marks = Array.from(bar.querySelectorAll('[aria-hidden]')) as HTMLElement[];
    expect(marks.map((m) => m.style.left)).toEqual(['calc(50% - 1px)', 'calc(80% - 1px)']);
  });
});

