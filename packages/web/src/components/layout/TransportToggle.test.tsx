import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, beforeEach, afterEach, describe, it, expect } from 'vitest';
import { TransportToggle } from './TransportToggle';
import { useTabs } from '../../stores/tabs';
import { api } from '../../api/client';

function seedTab(tab: Record<string, unknown>) {
  useTabs.setState({ byProject: { s1: [{ id: 't1', sessionId: 's1', type: 'claude-code', config: {}, ...tab } as any] } });
}

beforeEach(() => {
  useTabs.setState({ byProject: {}, openTabIds: [], activeTabId: null, tabSession: {} });
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

  it('switches a Pretty thread back to CLI', async () => {
    seedTab({ type: 'claude-code', externalId: 'e1', config: { transport: 'structured' } });
    const spy = vi.spyOn(api, 'switchTransport').mockResolvedValue({} as any);
    vi.spyOn(api, 'listTerminals').mockResolvedValue([]);
    render(<TransportToggle terminalId="t1" />);
    fireEvent.click(screen.getByRole('button', { name: /cli/i }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith('t1', 'pty'));
  });
});
