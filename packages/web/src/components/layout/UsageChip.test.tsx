import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { UsageChip, UsageTable } from './UsageChip';
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

  it('rail: one ring per tool with the figure in its label, opens the sheet on click', () => {
    useUsageLimits.setState({ summary: summary(46) });
    render(<UsageChip variant="rail" />);
    const chip = screen.getByTestId('usage-chip');
    const rings = screen.getAllByTestId('usage-ring');
    expect(rings.map((r) => r.getAttribute('data-provider'))).toEqual(['claude-code']);
    expect(rings[0].getAttribute('aria-valuenow')).toBe('46'); // the window closest to its limit
    expect(rings[0].getAttribute('aria-label')).toBe('Claude: 5-hour 46% used, weekly 21% used');
    expect(chip.getAttribute('data-tone')).toBe('normal');
    fireEvent.click(chip);
    // The ring counts up to the figure: its accessible label carries the figure at once.
    expect(screen.getByRole('dialog', { name: 'Usage limits' }).querySelector('[role="meter"]')!.getAttribute('aria-label')).toContain('5-hour: 46% used');
    expect(screen.getByRole('region', { name: 'Claude' })).toBeInTheDocument();
  });

  it('rail: every tool gets a ring, stacked, Codex included (2026-11-06: the chip used to show Claude alone)', () => {
    useUsageLimits.setState({ summary: summary(0, { providers: [
      { provider: 'claude-code', asOf: Date.now() - 60_000, windows: { seven_day: { usedPercent: 21, resetsAt: Date.now() + 72 * H } } },
      { provider: 'codex', asOf: Date.now() - 60_000, windows: { seven_day: { usedPercent: 2, resetsAt: Date.now() + 72 * H } } },
    ] }) });
    render(<UsageChip variant="rail" />);
    const rings = screen.getAllByTestId('usage-ring');
    expect(rings.map((r) => [r.getAttribute('data-provider'), r.getAttribute('aria-valuenow')])).toEqual([['claude-code', '21'], ['codex', '2']]);
    expect(screen.getByTestId('usage-chip').getAttribute('aria-label')).toContain('Codex: weekly 2% used');
  });

  it('phone: a ring per tool, amber at the threshold, red while paused', () => {
    useUsageLimits.setState({ summary: summary(85) });
    const { rerender } = render(<UsageChip variant="phone" />);
    expect(screen.getByTestId('usage-ring').getAttribute('aria-valuenow')).toBe('85');
    expect(screen.getByTestId('usage-chip').getAttribute('data-tone')).toBe('amber');
    useUsageLimits.setState({ summary: summary(85, { paused: [{ provider: 'claude-code', kind: 'session', earliestResetsAt: Date.now() + H, threads: 2, capped: 0, chat: false, firstTerminalId: 't', firstSessionId: 's', episodeStartedAt: 1 }] }) });
    rerender(<UsageChip variant="phone" />);
    expect(screen.getByTestId('usage-chip').getAttribute('data-tone')).toBe('red');
    fireEvent.click(screen.getByTestId('usage-chip'));
    expect(screen.getByTestId('usage-rings').textContent).toContain('Claude agents paused: session limit');
  });

  // #131: a paused Codex with no figures used to leave the chip hidden and the sheet empty.
  it('a paused tool with no figures: red chip, and the popover and the table name the pause', () => {
    const pause = { provider: 'codex', kind: 'session', earliestResetsAt: Date.now() + H, threads: 1, capped: 0, chat: false, firstTerminalId: 't', firstSessionId: 's', episodeStartedAt: 1, latestStartedAt: 1, activeUntil: Date.now() + H };
    const s = summary(0, { providers: [], paused: [pause] });
    useUsageLimits.setState({ summary: s });
    render(<UsageChip variant="rail" />);
    const chip = screen.getByTestId('usage-chip');
    expect(chip.getAttribute('data-tone')).toBe('red');
    fireEvent.click(chip);
    expect(screen.getByTestId('usage-rings').textContent).toContain('Codex agents paused: session limit');
    render(<UsageTable summary={s} now={Date.now()} />);
    expect(screen.getByTestId('usage-table').textContent).toContain('Codex agents paused: session limit');
  });

  it('recolors when the threshold changes live', () => {
    useUsageLimits.setState({ summary: summary(70) });
    render(<UsageChip variant="rail" />);
    expect(screen.getByTestId('usage-chip').getAttribute('data-tone')).toBe('normal');
    act(() => { useUsageLimits.getState().applyEvent({ type: 'usage-limits', ...summary(70), warnPercent: 65 }); });
    expect(screen.getByTestId('usage-chip').getAttribute('data-tone')).toBe('amber');
  });

  it('a warning never draws a colored outline around the rings: the rings carry the color (2026-11-07)', () => {
    useUsageLimits.setState({ summary: summary(85) });
    const { unmount } = render(<UsageChip variant="phone" />);
    let chip = screen.getByTestId('usage-chip');
    expect(chip.getAttribute('data-tone')).toBe('amber');
    expect(chip.style.borderColor === '' || chip.style.borderColor === 'transparent').toBe(true);
    unmount();
    render(<UsageChip variant="rail" />);
    chip = screen.getByTestId('usage-chip');
    expect(chip.style.border).not.toMatch(/var\(--color-(warning|danger|amber|red)/);
    expect(chip.style.borderColor === '' || chip.style.borderColor === 'transparent').toBe(true);
  });

  it('in a thread: only the ring of the account that thread uses (2026-11-07)', () => {
    const W = { seven_day: { usedPercent: 30, resetsAt: Date.now() + 72 * H } };
    useUsageLimits.setState({ summary: summary(10, { providers: [
      { provider: 'claude-code', accountId: 'cli', label: 'Ultra 1', asOf: Date.now(), windows: W },
      { provider: 'claude-code', accountId: 'w1', label: 'Team', asOf: Date.now(), windows: W },
      { provider: 'codex', accountId: 'cli', label: 'Pro', asOf: Date.now(), windows: W },
    ] as any }) });
    const { rerender } = render(<UsageChip variant="phone" only={{ provider: 'claude-code', accountId: 'w1' }} />);
    expect(screen.getAllByTestId('usage-ring')).toHaveLength(1);
    expect(screen.getByTestId('usage-chip').getAttribute('aria-label')).toContain('Team');
    rerender(<UsageChip variant="phone" only={{ provider: 'grok', accountId: 'cli' }} />);
    expect(screen.queryByTestId('usage-chip')).toBeNull();
    rerender(<UsageChip variant="phone" />);
    expect(screen.getAllByTestId('usage-ring')).toHaveLength(3);
  });

  it('the details from a thread mark that thread\'s account "This account" and list it first; the rest stay (2026-11-07)', () => {
    const W = { seven_day: { usedPercent: 30, resetsAt: Date.now() + 72 * H } };
    useUsageLimits.setState({ summary: summary(10, { providers: [
      { provider: 'claude-code', accountId: 'cli', label: 'Ultra 1', asOf: Date.now(), windows: W },
      { provider: 'claude-code', accountId: 'w1', label: 'Team', asOf: Date.now(), windows: W },
    ] as any }) });
    render(<UsageChip variant="phone" only={{ provider: 'claude-code', accountId: 'w1' }} />);
    fireEvent.click(screen.getByTestId('usage-chip'));
    const cards = screen.getAllByRole('region');
    expect(cards).toHaveLength(2);
    expect(cards[0].getAttribute('data-current')).toBe('true');
    expect(cards[0].textContent).toContain('This account');
    expect(cards[0].textContent).toContain('Team');
    expect(cards[1].textContent).not.toContain('This account');
  });
});
