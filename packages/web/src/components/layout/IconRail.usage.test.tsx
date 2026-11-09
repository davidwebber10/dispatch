import { render, screen } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { IconRail } from './IconRail';
import { useUI } from '../../stores/ui';
import { useTabs } from '../../stores/tabs';
import { useAccounts } from '../../stores/accounts';
import { useUsageLimits } from '../../stores/usageLimits';

const H = 3600_000;
const w = (u: number) => ({ five_hour: { usedPercent: u, resetsAt: Date.now() + H } });

beforeEach(() => {
  useUI.setState({ view: 'workspace' });
  useUsageLimits.setState({ summary: { warnPercent: 80, paused: [], providers: [
    { provider: 'claude-code', accountId: 'cli', label: 'CLI login', asOf: Date.now(), windows: w(10) },
    { provider: 'claude-code', accountId: 'work', label: 'Work', asOf: Date.now(), windows: w(20) },
    { provider: 'codex', accountId: 'cli', asOf: Date.now(), windows: w(30) },
  ] } as never });
  useAccounts.setState({ view: { claude: [{ id: 'cli', label: 'CLI login' }, { id: 'work', label: 'Work' }], codex: [{ id: 'cli', label: 'CLI login' }], defaults: { claude: 'cli', codex: 'cli' } } as never, loading: false });
  useTabs.setState({ byProject: { p1: [
    { id: 't1', type: 'claude-code', config: { accountId: 'work' } },
    { id: 't2', type: 'codex', config: {} },
  ] } as never, activeTabId: 't1' });
});

const marked = () => screen.queryByTestId('usage-ring-current')?.querySelector('[data-testid="usage-ring"]');

describe('IconRail: the open thread\'s usage ring (2026-11-09)', () => {
  it('marks the pinned account of the open Claude thread', () => {
    render(<IconRail />);
    expect(marked()?.getAttribute('data-provider')).toBe('claude-code');
    expect(marked()?.getAttribute('data-account')).toBe('work');
  });

  it('an unpinned thread marks the default account of its tool', () => {
    useTabs.setState({ activeTabId: 't2' });
    render(<IconRail />);
    expect(marked()?.getAttribute('data-provider')).toBe('codex');
  });

  it('no mark outside the thread view', () => {
    useUI.setState({ view: 'settings' });
    render(<IconRail />);
    expect(marked()).toBeUndefined();
  });
});
