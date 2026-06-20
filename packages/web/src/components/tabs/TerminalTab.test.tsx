import { render, screen, waitFor } from '@testing-library/react';
import { vi, test, expect, beforeEach, afterEach } from 'vitest';

vi.mock('@xterm/xterm', () => ({
  Terminal: class { cols = 80; rows = 24; loadAddon() {} open() {} write() {} onData() {} onScroll() { return { dispose() {} }; } scrollToBottom() {} dispose() {} focus() {} },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));

import { TerminalTab } from './TerminalTab';
import { api } from '../../api/client';

beforeEach(() => {
  vi.spyOn(api, 'getTerminal').mockResolvedValue({ id: 't1', sessionId: 's1', workingDir: '/p/x', pid: 4242, status: 'working' } as any);
  vi.spyOn(api, 'getGitInfo').mockResolvedValue({ branch: 'main' });
});
afterEach(() => vi.restoreAllMocks());

test('writes replayed output into the terminal and shows the status bar', async () => {
  let onData!: (c: string) => void;
  const fakeFactory = (opts: any) => { onData = opts.onData; return { send: vi.fn(), resize: vi.fn(), close: vi.fn() }; };

  render(<TerminalTab terminalId="t1" socketFactory={fakeFactory as any} />);
  await waitFor(() => expect(api.getTerminal).toHaveBeenCalledWith('t1'));
  onData('hello-from-pty');

  expect(await screen.findByText(/main/)).toBeInTheDocument();
  expect(screen.getByText(/4242/)).toBeInTheDocument();
});
