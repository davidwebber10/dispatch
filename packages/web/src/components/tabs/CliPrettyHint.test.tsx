import { expect, test, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { CliPrettyHint, CLI_PRETTY_HINT_KEY } from './CliPrettyHint';
import { useThreadStatus } from '../../stores/threadStatus';
import { useTabs } from '../../stores/tabs';
import { api } from '../../api/client';
import type { Terminal } from '../../api/types';

vi.mock('../../api/client', () => ({
  api: { switchTransport: vi.fn().mockResolvedValue({}) },
}));

function cliTab(over: Partial<Terminal> = {}): Terminal {
  return {
    id: 't1', sessionId: 's1', type: 'claude-code', label: 'thread', pid: 123, externalId: 'ext-1',
    workingDir: null, status: 'idle', createdAt: '', config: {}, archivedAt: null, sortOrder: 0,
    ...over,
  } as unknown as Terminal;
}

beforeEach(() => {
  localStorage.clear();
  useThreadStatus.setState({ byTerminal: {} } as any);
  vi.spyOn(useTabs.getState(), 'loadTabs').mockResolvedValue(undefined as any);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); (api.switchTransport as any).mockClear(); });

test('shows the nudge with an enabled switch on an idle CLI thread', () => {
  render(<CliPrettyHint tab={cliTab()} />);
  expect(screen.getByText(/read best in Pretty/i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Switch to Pretty' })).toBeEnabled();
});

test('the switch is disabled mid-turn — same gate as the transport toggle', () => {
  useThreadStatus.setState({ byTerminal: { t1: { threadStatus: 'working' } } } as any);
  render(<CliPrettyHint tab={cliTab()} />);
  expect(screen.getByRole('button', { name: 'Switch to Pretty' })).toBeDisabled();
});

test('the switch is disabled until a session id is captured', () => {
  render(<CliPrettyHint tab={cliTab({ externalId: null })} />);
  expect(screen.getByRole('button', { name: 'Switch to Pretty' })).toBeDisabled();
});

test('clicking the switch changes the transport to structured and reloads the tabs', async () => {
  render(<CliPrettyHint tab={cliTab()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Switch to Pretty' }));
  await waitFor(() => expect(api.switchTransport).toHaveBeenCalledWith('t1', 'structured'));
  await waitFor(() => expect(useTabs.getState().loadTabs).toHaveBeenCalledWith('s1'));
});

test('dismissal hides the hint and persists across mounts (a one-time education, not a nag)', () => {
  render(<CliPrettyHint tab={cliTab()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
  expect(screen.queryByText(/read best in Pretty/i)).not.toBeInTheDocument();
  expect(localStorage.getItem(CLI_PRETTY_HINT_KEY)).toBe('1');
  cleanup();
  render(<CliPrettyHint tab={cliTab({ id: 't2' })} />);
  expect(screen.queryByText(/read best in Pretty/i)).not.toBeInTheDocument();
});
