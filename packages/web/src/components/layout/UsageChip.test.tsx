import { useSettings } from '../../stores/settings';
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

  // A fixed order (owner, 2026-11-13): the open thread's account is marked, never moved to the top.
  it('the details from a thread mark that thread\'s account "This thread" and keep the listed order', () => {
    const W = { seven_day: { usedPercent: 30, resetsAt: Date.now() + 72 * H } };
    useUsageLimits.setState({ summary: summary(10, { providers: [
      { provider: 'claude-code', accountId: 'cli', label: 'Ultra 1', asOf: Date.now(), windows: W },
      { provider: 'claude-code', accountId: 'w1', label: 'Team', asOf: Date.now(), windows: W },
    ] as any }) });
    render(<UsageChip variant="phone" only={{ provider: 'claude-code', accountId: 'w1' }} />);
    fireEvent.click(screen.getByTestId('usage-chip'));
    const cards = screen.getAllByRole('region');
    expect(cards).toHaveLength(2);
    expect(cards[0].textContent).toContain('Ultra 1');
    expect(cards[0].querySelector('[data-testid="usage-current-tab"]')).toBeNull();
    // A tab on the card's top-right border (2026-11-09), green with dark text.
    expect(cards[1].getAttribute('data-current')).toBe('true');
    expect(cards[1].querySelector('[data-testid="usage-current-tab"]')).toHaveTextContent('This thread');
    expect(cards[1].textContent).toContain('Team');
  });

  it('the per-device setting puts the percent used in the ring instead of the logo (2026-11-07)', () => {
    useUsageLimits.setState({ summary: summary(10) });
    useSettings.getState().setUsageRingCenter('percent');
    const { unmount } = render(<UsageChip variant="phone" />);
    expect(screen.getByTestId('usage-ring').textContent).toBe('21');
    unmount();
    useSettings.getState().setUsageRingCenter('logo');
    render(<UsageChip variant="phone" />);
    expect(screen.getByTestId('usage-ring').textContent).toBe('');
  });

  it('phone: the all-accounts rings can be hidden (outside a thread); a thread still shows its own account (2026-11-07)', () => {
    useUsageLimits.setState({ summary: summary(10) });
    const { rerender } = render(<UsageChip variant="phone" hideAll />);
    expect(screen.queryByTestId('usage-chip')).toBeNull();
    rerender(<UsageChip variant="phone" hideAll only={{ provider: 'claude-code', accountId: 'cli' }} />);
    expect(screen.getAllByTestId('usage-ring')).toHaveLength(1);
    rerender(<UsageChip variant="phone" />);
    expect(screen.getByTestId('usage-chip')).toBeInTheDocument();
  });
});

describe('rail: the open thread\'s account (2026-11-09)', () => {
  const two = () => summary(0, { providers: [
    { provider: 'claude-code', accountId: 'work', label: 'Work', asOf: Date.now() - 60_000, windows: { five_hour: { usedPercent: 10, resetsAt: Date.now() + H } } },
    { provider: 'claude-code', accountId: 'home', label: 'Home', asOf: Date.now() - 60_000, windows: { five_hour: { usedPercent: 30, resetsAt: Date.now() + H } } },
  ] as never });

  it('marks the ring of the current thread\'s account, and only that ring', () => {
    useUsageLimits.setState({ summary: two() });
    render(<UsageChip variant="rail" current={{ provider: 'claude-code', accountId: 'home' }} />);
    expect(screen.getAllByTestId('usage-ring')).toHaveLength(2); // every account still shows
    const marks = screen.getAllByTestId('usage-ring-current');
    expect(marks).toHaveLength(1);
    expect(marks[0].querySelector('[data-testid="usage-ring"]')!.getAttribute('data-account')).toBe('home');
    expect(screen.getByTestId('usage-chip').getAttribute('aria-label')).toContain('This thread uses Claude · Home');
  });

  it('the popover marks the same account', () => {
    useUsageLimits.setState({ summary: two() });
    render(<UsageChip variant="rail" current={{ provider: 'claude-code', accountId: 'home' }} />);
    fireEvent.click(screen.getByTestId('usage-chip'));
    const card = screen.getByRole('region', { name: 'Claude · Home' });
    expect(card.getAttribute('data-current')).toBe('true');
    expect(card.querySelector('[data-testid="usage-current-tab"]')).toHaveTextContent('This thread');
    expect(card.textContent).not.toMatch(/This account|\bThis\b(?! thread)/);
  });

  // Owner, 2026-11-13: "it always puts active on top, this is confusing. can we have a static order, and
  // then the highlighted account just changes ... an animation where the highlight slides to the account".
  it('the rail and the flyout keep one fixed order, whatever the open thread', () => {
    useUsageLimits.setState({ summary: two() });
    const { rerender } = render(<UsageChip variant="rail" current={{ provider: 'claude-code', accountId: 'home' }} />);
    const order = () => screen.getAllByTestId('usage-ring').map((r) => r.getAttribute('data-account'));
    expect(order()).toEqual(['work', 'home']);
    rerender(<UsageChip variant="rail" current={{ provider: 'claude-code', accountId: 'work' }} />);
    expect(order()).toEqual(['work', 'home']);
    fireEvent.click(screen.getByTestId('usage-chip'));
    const cards = screen.getByRole('dialog', { name: 'Usage limits' }).querySelectorAll('section[aria-label]');
    expect([...cards].map((c) => c.getAttribute('aria-label'))).toEqual(['Claude · Work', 'Claude · Home']);
  });

  it('one highlight sits behind the current ring and moves to the next account; every slot has the same size', () => {
    useUsageLimits.setState({ summary: two() });
    const { rerender } = render(<UsageChip variant="rail" current={{ provider: 'claude-code', accountId: 'work' }} />);
    const hl = () => screen.getByTestId('usage-ring-highlight');
    const first = hl().style.transform;
    rerender(<UsageChip variant="rail" current={{ provider: 'claude-code', accountId: 'home' }} />);
    expect(screen.getAllByTestId('usage-ring-highlight')).toHaveLength(1); // the same box, moved
    expect(hl().style.transform).not.toBe(first);
    expect(hl().style.transition).toMatch(/transform/);
    const slots = [...document.querySelectorAll<HTMLElement>('[data-rail-slot]')].map((s) => s.style.height);
    expect(slots).toHaveLength(2);
    expect(new Set(slots).size).toBe(1); // nothing below shifts when the highlight moves
  });

  it('no open thread: no mark', () => {
    useUsageLimits.setState({ summary: two() });
    render(<UsageChip variant="rail" current={null} />);
    expect(screen.queryByTestId('usage-ring-current')).toBeNull();
    expect(screen.queryByTestId('usage-ring-highlight')).toBeNull();
  });
});
