import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { UsageChip } from './UsageChip';
import { useUsageLimits } from '../../stores/usageLimits';
import type { UsageSummary } from '../../api/types';

const H = 3600_000;
const summary = (five: number, o: Partial<UsageSummary> = {}): UsageSummary => ({
  warnPercent: 80,
  providers: [{ provider: 'claude-code', asOf: Date.now() - 60_000, windows: { five_hour: { usedPercent: five, resetsAt: Date.now() + 2 * H }, seven_day: { usedPercent: 21, resetsAt: Date.now() + 72 * H } } }],
  paused: [],
  ...o,
});

beforeEach(() => { useUsageLimits.setState({ summary: null }); });

describe('UsageChip', () => {
  it('renders nothing with no data', () => {
    const { container } = render(<UsageChip variant="rail" />);
    expect(container.innerHTML).toBe('');
  });

  it('rail: two lines, opens the table on click', () => {
    useUsageLimits.setState({ summary: summary(46) });
    render(<UsageChip variant="rail" />);
    const chip = screen.getByTestId('usage-chip');
    expect(chip.textContent).toBe('5h 46wk 21');
    expect(chip.getAttribute('data-tone')).toBe('normal');
    fireEvent.click(chip);
    // The ring counts up to the figure: its accessible label carries the figure at once.
    expect(screen.getByRole('dialog', { name: 'Usage limits' }).querySelector('[role="img"]')!.getAttribute('aria-label')).toContain('46% of 5-hour used');
    expect(screen.getByRole('region', { name: 'Claude' })).toBeInTheDocument();
  });

  it('rail: a tool with no 5-hour window shows only its weekly line', () => {
    useUsageLimits.setState({ summary: summary(0, { providers: [{ provider: 'claude-code', asOf: Date.now() - 60_000, windows: { seven_day: { usedPercent: 21, resetsAt: Date.now() + 72 * H } } }] }) });
    render(<UsageChip variant="rail" />);
    expect(screen.getByTestId('usage-chip').textContent).toBe('wk 21');
  });

  it('phone: one value, amber at the threshold, red while paused', () => {
    useUsageLimits.setState({ summary: summary(85) });
    const { rerender } = render(<UsageChip variant="phone" />);
    expect(screen.getByTestId('usage-chip').textContent).toBe('85%');
    expect(screen.getByTestId('usage-chip').getAttribute('data-tone')).toBe('amber');
    useUsageLimits.setState({ summary: summary(85, { paused: [{ provider: 'claude-code', kind: 'session', earliestResetsAt: Date.now() + H, threads: 2, capped: 0, chat: false, firstTerminalId: 't', firstSessionId: 's', episodeStartedAt: 1 }] }) });
    rerender(<UsageChip variant="phone" />);
    expect(screen.getByTestId('usage-chip').getAttribute('data-tone')).toBe('red');
    fireEvent.click(screen.getByTestId('usage-chip'));
    expect(screen.getByTestId('usage-rings').textContent).toContain('Claude agents paused: session limit');
  });

  it('recolors when the threshold changes live', () => {
    useUsageLimits.setState({ summary: summary(70) });
    render(<UsageChip variant="rail" />);
    expect(screen.getByTestId('usage-chip').getAttribute('data-tone')).toBe('normal');
    act(() => { useUsageLimits.getState().applyEvent({ type: 'usage-limits', ...summary(70), warnPercent: 65 }); });
    expect(screen.getByTestId('usage-chip').getAttribute('data-tone')).toBe('amber');
  });
});
