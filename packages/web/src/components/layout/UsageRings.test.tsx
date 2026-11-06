import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import { api } from '../../api/client';
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
    expect(within(claude).getByRole('img').getAttribute('aria-label')).toBe('Claude: 82% of 5-hour used, 18% left');
    expect(claude.textContent).not.toContain('82% used'); // the ring holds that number; no second copy
    expect(within(claude).getByRole('button', { name: /weekly/ }).textContent).toContain('21%'); // the other limit keeps its own
    // Short on the row, marked EST; the pace it is based on is in the tooltip.
    expect(claude.textContent).toContain('out ~');
    expect(claude.textContent).toContain('EST');
    expect(claude.textContent).toContain('lasts to reset');
    expect(claude.querySelector('[title^="At the last 2 h pace it runs out around"]')).not.toBeNull();
    expect(within(screen.getByRole('region', { name: 'Codex' })).getByRole('img').getAttribute('aria-label')).toContain('4% of weekly used');
  });

  it('a tool with no current figure gets no ring', () => {
    const s = summary({ providers: [{ provider: 'codex', asOf: now, windows: { seven_day: { usedPercent: null, resetsAt: now + H } } }] });
    render(<UsageRings summary={s} now={now} />);
    expect(screen.getByText('No figures reported yet')).toBeInTheDocument();
  });

  it('banked resets show on the card, ask first, and say what happened', async () => {
    const spend = vi.spyOn(api, 'useResetCredit').mockResolvedValue({ outcome: 'reset' });
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
    fireEvent.click(within(codex).getByRole('button', { name: '3 resets banked · Use one' }));
    expect(screen.getByText(/the one expiring (today|tomorrow)/)).toBeInTheDocument();
    expect(spend).not.toHaveBeenCalled(); // confirmation first
    fireEvent.click(screen.getByRole('button', { name: 'Use one' }));
    await waitFor(() => expect(spend).toHaveBeenCalledWith('codex', 'soon')); // the one that would lapse first
    expect(await within(codex).findByText('Reset used: the limit is back to zero.')).toBeInTheDocument();
    spend.mockRestore();
  });

  it('the ring counts up to its figure, and tapping another limit puts that one in the ring', async () => {
    render(<UsageRings summary={summary()} now={now} />);
    const claude = screen.getByRole('region', { name: 'Claude' });
    await waitFor(() => expect(claude.textContent).toContain('82%5-hour used')); // counted up from 0
    const weekly = within(claude).getByRole('button', { name: /weekly/ });
    expect(weekly.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(weekly);
    expect(weekly.getAttribute('aria-pressed')).toBe('true');
    expect(within(claude).getByRole('img').getAttribute('aria-label')).toBe('Claude: 21% of weekly used, 79% left');
    await waitFor(() => expect(claude.textContent).toContain('21%weekly used'));
  });

  it('a tool with one limit has a plain row, nothing to tap', () => {
    render(<UsageRings summary={summary()} now={now} />);
    expect(within(screen.getByRole('region', { name: 'Codex' })).queryByRole('button', { name: /weekly/ })).toBeNull();
  });
});

