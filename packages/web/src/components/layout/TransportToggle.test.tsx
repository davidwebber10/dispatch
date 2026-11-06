import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { vi, beforeEach, afterEach, describe, it, expect } from 'vitest';
import { TransportToggle } from './TransportToggle';
import { useTabs } from '../../stores/tabs';
import { useThreadStatus } from '../../stores/threadStatus';
import { api } from '../../api/client';

function seedTab(tab: Record<string, unknown>) {
  useTabs.setState({ byProject: { s1: [{ id: 't1', sessionId: 's1', type: 'claude-code', config: {}, ...tab } as any] } });
}

beforeEach(() => {
  useTabs.setState({ byProject: {}, openTabIds: [], activeTabId: null, tabSession: {} });
  useThreadStatus.setState({ byTerminal: {} });
  vi.restoreAllMocks();
});
afterEach(() => vi.restoreAllMocks());

describe('TransportToggle', () => {
  it('renders nothing for a non-AI (shell) tab', () => {
    seedTab({ type: 'shell', externalId: 'e1' });
    const { container } = render(<TransportToggle terminalId="t1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('disables the switch target until the thread has an external_id', () => {
    seedTab({ type: 'claude-code', externalId: null, config: {} }); // CLI thread, never ran
    render(<TransportToggle terminalId="t1" />);
    expect(screen.getByRole('button', { name: /pretty/i })).toBeDisabled();
  });

  it('switches a CLI thread to Pretty and reloads tabs', async () => {
    seedTab({ type: 'claude-code', externalId: 'e1', config: {} });
    const spy = vi.spyOn(api, 'switchTransport').mockResolvedValue({} as any);
    vi.spyOn(api, 'listTerminals').mockResolvedValue([]);
    render(<TransportToggle terminalId="t1" />);
    fireEvent.click(screen.getByRole('button', { name: /pretty/i }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith('t1', 'structured'));
  });

  it('mid-turn it still switches, after asking: stop the turn and restart in the other mode (2026-11-06)', async () => {
    seedTab({ type: 'claude-code', externalId: 'e1', config: {} });
    useThreadStatus.setState({ byTerminal: { t1: { threadStatus: 'working' } } });
    const spy = vi.spyOn(api, 'switchTransport').mockResolvedValue({} as any);
    render(<TransportToggle terminalId="t1" />);
    const pretty = screen.getByRole('button', { name: /pretty/i });
    expect(pretty).toBeEnabled();
    expect(screen.getByRole('group', { name: 'Transport' }).style.opacity).toBe('1');
    fireEvent.click(pretty);
    expect(spy).not.toHaveBeenCalled(); // asks first
    const ask = screen.getByRole('alertdialog', { name: 'Switch to Pretty now?' });
    expect(ask.textContent).toContain('stops the current turn');
    fireEvent.click(within(ask).getByRole('button', { name: 'Stop and switch' }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith('t1', 'structured', { force: true }));
  });

  it('between turns it switches straight away, without asking', async () => {
    seedTab({ type: 'claude-code', externalId: 'e1', config: {} });
    useThreadStatus.setState({ byTerminal: { t1: { threadStatus: 'idle' } } });
    const spy = vi.spyOn(api, 'switchTransport').mockResolvedValue({} as any);
    render(<TransportToggle terminalId="t1" />);
    fireEvent.click(screen.getByRole('button', { name: /pretty/i }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() => expect(spy).toHaveBeenCalledWith('t1', 'structured'));
  });

  it('is at full opacity when a switch IS available (between turns)', () => {
    seedTab({ type: 'claude-code', externalId: 'e1', config: {} });
    useThreadStatus.setState({ byTerminal: { t1: { threadStatus: 'idle' } } });
    render(<TransportToggle terminalId="t1" />);
    expect(screen.getByRole('group', { name: 'Transport' }).style.opacity).toBe('1');
  });

  it('switches a Pretty thread back to CLI', async () => {
    seedTab({ type: 'claude-code', externalId: 'e1', config: { transport: 'structured' } });
    const spy = vi.spyOn(api, 'switchTransport').mockResolvedValue({} as any);
    vi.spyOn(api, 'listTerminals').mockResolvedValue([]);
    render(<TransportToggle terminalId="t1" />);
    fireEvent.click(screen.getByRole('button', { name: /cli/i }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith('t1', 'pty'));
  });
});
