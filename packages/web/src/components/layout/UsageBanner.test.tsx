import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { UsageBanner } from './UsageBanner';
import { bannerText } from './usageGauge';
import { useUsageLimits } from '../../stores/usageLimits';
import { useSettings } from '../../stores/settings';
import { useDismissedNotices } from '../../stores/dismissedNotices';
import { useUI } from '../../stores/ui';
import type { UsagePausedGroup } from '../../api/types';

const NOW = Date.UTC(2026, 10, 5, 5, 0);
const RESET = Date.UTC(2026, 10, 5, 6, 10);
const g = (o: Partial<UsagePausedGroup> = {}): UsagePausedGroup => ({
  provider: 'claude-code', kind: 'session', earliestResetsAt: RESET, threads: 3, capped: 0, chat: false, firstTerminalId: 't1', firstSessionId: 's1', episodeStartedAt: 100, latestStartedAt: 100, activeUntil: RESET, ...o,
});

describe('bannerText', () => {
  it('names the provider, the limit, the resume time and the count', () => {
    expect(bannerText(g(), NOW, 'UTC')).toBe('Claude agents paused: session limit, resumes 6:10 AM (3 threads)');
    expect(bannerText(g({ threads: 1 }), NOW, 'UTC')).toBe('Claude agents paused: session limit, resumes 6:10 AM (1 thread)');
  });
  it('an unknown reset, a reset already passed, a weekly and a Fable limit', () => {
    expect(bannerText(g({ earliestResetsAt: null }), NOW)).toBe('Claude agents paused: session limit, reset time unknown (3 threads)');
    expect(bannerText(g({ earliestResetsAt: NOW - 1 }), NOW)).toBe('Claude agents paused: session limit, resuming now (3 threads)');
    expect(bannerText(g({ kind: 'weekly', earliestResetsAt: Date.UTC(2026, 10, 9, 14, 0) }), NOW, 'UTC')).toBe('Claude agents paused: weekly limit, resumes Mon 2:00 PM (3 threads)');
    expect(bannerText(g({ kind: 'fable', provider: 'codex' }), NOW, 'UTC')).toBe('Codex agents paused: Fable limit, resumes 6:10 AM (3 threads)');
  });
  it('adds the capped count, and says stopped when every row is capped', () => {
    expect(bannerText(g({ capped: 1 }), NOW, 'UTC')).toBe('Claude agents paused: session limit, resumes 6:10 AM (3 threads), 1 stopped after 5 tries');
    expect(bannerText(g({ threads: 2, capped: 2 }), NOW)).toBe('Claude agents stopped: session limit, auto-resume gave up (2 threads)');
  });
  it('says Chat when Chat is the only one', () => {
    expect(bannerText(g({ threads: 1, chat: true, firstTerminalId: 'endless-chat', firstSessionId: null }), NOW, 'UTC')).toBe('Chat paused: session limit, resumes 6:10 AM');
  });
});

describe('UsageBanner', () => {
  beforeEach(() => {
    localStorage.clear();
    useDismissedNotices.setState({ keys: [] });
    useSettings.setState({ showUsageBanner: true });
    useUsageLimits.setState({ summary: { warnPercent: 80, providers: [], paused: [g()] } });
  });

  it('renders nothing with no pause', () => {
    useUsageLimits.setState({ summary: { warnPercent: 80, providers: [], paused: [] } });
    const { container } = render(<UsageBanner />);
    expect(container.innerHTML).toBe('');
  });

  it('shows the line and opens the first paused thread on click', () => {
    const open = vi.spyOn(useUI.getState(), 'requestOpenThread');
    render(<UsageBanner />);
    const line = screen.getByText(/Claude agents paused: session limit/);
    fireEvent.click(line);
    expect(open).toHaveBeenCalledWith({ sessionId: 's1', terminalId: 't1' });
  });

  it('Chat alone opens Chat', () => {
    useUsageLimits.setState({ summary: { warnPercent: 80, providers: [], paused: [g({ threads: 1, chat: true, firstTerminalId: 'endless-chat', firstSessionId: null })] } });
    const onOpenChat = vi.fn();
    render(<UsageBanner onOpenChat={onOpenChat} />);
    fireEvent.click(screen.getByText(/Chat paused/));
    expect(onOpenChat).toHaveBeenCalled();
  });

  it('the device toggle off hides it', () => {
    useSettings.setState({ showUsageBanner: false });
    const { container } = render(<UsageBanner />);
    expect(container.innerHTML).toBe('');
  });

  it('the × holds when another thread resumes, and a newer pause shows it again', () => {
    render(<UsageBanner />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide until the next pause' }));
    // The oldest thread resumes: the earliest pause time moves, but nothing new paused.
    act(() => { useUsageLimits.setState({ summary: { warnPercent: 80, providers: [], paused: [g({ threads: 2, episodeStartedAt: 150, latestStartedAt: 100 })] } }); });
    expect(screen.queryByTestId('usage-banner')).toBeNull();
    // A second thread pauses while the first stays paused: that is a new pause.
    act(() => { useUsageLimits.setState({ summary: { warnPercent: 80, providers: [], paused: [g({ threads: 4, episodeStartedAt: 100, latestStartedAt: 200 })] } }); });
    expect(screen.getByTestId('usage-banner')).toBeTruthy();
  });

  it('the × holds until a new pause episode', () => {
    render(<UsageBanner />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide until the next pause' }));
    expect(screen.queryByTestId('usage-banner')).toBeNull();
    // Same episode, new figures: still hidden.
    act(() => { useUsageLimits.setState({ summary: { warnPercent: 80, providers: [], paused: [g({ threads: 4 })] } }); });
    expect(screen.queryByTestId('usage-banner')).toBeNull();
    // A new episode (new earliest pause): shown again.
    act(() => { useUsageLimits.setState({ summary: { warnPercent: 80, providers: [], paused: [g({ episodeStartedAt: 200, latestStartedAt: 200 })] } }); });
    expect(screen.getByTestId('usage-banner')).toBeTruthy();
  });
});
