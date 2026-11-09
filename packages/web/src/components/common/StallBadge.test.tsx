import { render, act } from '@testing-library/react';
import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { StallBadge, stallTitle } from './StallBadge';
import { useThreadStatus } from '../../stores/threadStatus';
import { api } from '../../api/client';

const NOW = Date.parse('2026-11-09T10:30:00.000Z');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.spyOn(api, 'listStalls').mockResolvedValue([]);
  useThreadStatus.setState({ byTerminal: {}, stalls: {} });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

test('renders nothing with no stall', () => {
  const { container } = render(<StallBadge terminalId="t1" />);
  expect(container.firstChild).toBeNull();
});

test('renders nothing for a stall of another thread', () => {
  useThreadStatus.setState({ stalls: { other: NOW - 15 * 60_000 } });
  const { container } = render(<StallBadge terminalId="t1" />);
  expect(container.firstChild).toBeNull();
});

test('shows an hourglass icon with the minutes of silence in its title', () => {
  useThreadStatus.setState({ stalls: { t1: NOW - 12 * 60_000 - 20_000 } });
  const { getByRole, container } = render(<StallBadge terminalId="t1" />);
  const badge = getByRole('img');
  expect(badge.getAttribute('title')).toBe('No output for 12 min. The thread can still be at work.');
  expect(badge.getAttribute('aria-label')).toBe('No output for 12 min. The thread can still be at work.');
  expect(container.querySelector('svg')).not.toBeNull();
  // Neutral colour: a text token, not a status colour. No emoji.
  expect(badge.style.color).toBe('var(--color-text-tertiary)');
  expect(badge.textContent).toBe('');
});

test('the minutes count up while the badge shows', () => {
  useThreadStatus.setState({ stalls: { t1: NOW - 10 * 60_000 } });
  const { getByRole } = render(<StallBadge terminalId="t1" />);
  expect(getByRole('img').getAttribute('title')).toContain('10 min');
  act(() => { vi.advanceTimersByTime(3 * 60_000); });
  expect(getByRole('img').getAttribute('title')).toContain('13 min');
});

test('goes away when the flag clears', () => {
  useThreadStatus.setState({ stalls: { t1: NOW - 10 * 60_000 } });
  const { container } = render(<StallBadge terminalId="t1" />);
  expect(container.firstChild).not.toBeNull();
  act(() => { useThreadStatus.getState().applyEvent({ type: 'terminal:stall', terminalId: 't1', stalledSince: null }); });
  expect(container.firstChild).toBeNull();
});

test('stallTitle never shows less than 1 minute', () => {
  expect(stallTitle(NOW, NOW)).toBe('No output for 1 min. The thread can still be at work.');
  expect(stallTitle(NOW - 61 * 60_000, NOW)).toBe('No output for 61 min. The thread can still be at work.');
});

// Wave 1 integration: the badge is mounted in the sidebar thread row and in both tab strips.
test('the thread row and the tab strip render the badge (Wave 1 integration)', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const src = (f: string) => readFileSync(join(__dirname, '..', f), 'utf8');
  expect(src('sidebar/ProjectCard.tsx')).toMatch(/<StallBadge terminalId=\{tab\.id\}/);
  expect(src('panes/GroupedTabBar.tsx').match(/<StallBadge terminalId=/g)?.length).toBe(2);
});
