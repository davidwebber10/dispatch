import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { ServersSection } from './ServersSection';
import { AboutSection } from './AboutSection';
import { useConnection } from '../../stores/connection';
import { useServers } from '../../stores/servers';
import { useSetup } from '../../stores/setup';
import { api } from '../../api/client';

const setWidth = (w: number) => Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: w });
const wide = window.innerWidth;

const realServers = useServers.getState();
beforeEach(() => {
  useServers.setState({ ...realServers, servers: [{ label: 'Studio', origin: 'https://studio.example:3456' }] } as never);
  useConnection.setState({ status: 'connecting' } as never);
});
afterEach(() => { setWidth(wide); vi.restoreAllMocks(); });

describe('ServersSection', () => {
  it('lists the other machines as rows in a Servers group, each with a labelled remove button', () => {
    setWidth(1200);
    render(<ServersSection />);
    const group = screen.getByRole('group', { name: 'Servers' });
    expect(within(group).getByText('Studio')).toBeInTheDocument();
    expect(within(group).getByText('https://studio.example:3456')).toBeInTheDocument();
    expect(within(group).getByRole('button', { name: 'Remove Studio' })).toBeInTheDocument();
  });

  it('removes a server only after a confirm', async () => {
    setWidth(1200);
    const remove = vi.fn().mockResolvedValue(undefined);
    useServers.setState({ remove } as never);
    render(<ServersSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Studio' }));
    expect(remove).not.toHaveBeenCalled();
    const dialog = screen.getByRole('alertdialog', { name: 'Remove Studio?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove server' }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith('https://studio.example:3456'));
  });

  it('adds a server from a sheet, not inline fields', async () => {
    setWidth(1200);
    const add = vi.fn().mockResolvedValue(undefined);
    useServers.setState({ add } as never);
    render(<ServersSection />);
    expect(screen.queryByLabelText('Server address')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add server…' }));
    fireEvent.change(screen.getByLabelText('Server label'), { target: { value: 'Mini' } });
    fireEvent.change(screen.getByLabelText('Server address'), { target: { value: 'https://mini:3456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }));
    await waitFor(() => expect(add).toHaveBeenCalledWith('Mini', 'https://mini:3456'));
    await waitFor(() => expect(screen.queryByLabelText('Server address')).toBeNull());
  });

  it('keeps the sheet open with a plain error when the add fails', async () => {
    setWidth(1200);
    useServers.setState({ add: vi.fn().mockRejectedValue(new Error('bad')) } as never);
    render(<ServersSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Add server…' }));
    fireEvent.change(screen.getByLabelText('Server label'), { target: { value: 'Mini' } });
    fireEvent.change(screen.getByLabelText('Server address'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/http\(s\) URL/);
    expect(screen.getByLabelText('Server address')).toBeInTheDocument();
  });

  it('with no other servers, says so and offers the add', () => {
    setWidth(1200);
    useServers.setState({ servers: [] } as never);
    render(<ServersSection />);
    expect(screen.getByTestId('empty-state')).toHaveTextContent(/No other servers yet/);
    expect(screen.getByRole('button', { name: 'Add server…' })).toBeInTheDocument();
  });

  it.each([[1200], [390]])('shows this device\'s connection in the same words as before, at width %i (the desktop nav no longer does)', (w) => {
    setWidth(w);
    render(<ServersSection />);
    expect(screen.getByTestId('connection-status').textContent).toContain('Reconnecting…');
    expect(within(screen.getByRole('group', { name: 'This device' })).getByText('Local')).toBeInTheDocument();
  });
});

describe('AboutSection', () => {
  it('re-runs the setup wizard and dismisses the settings chrome', () => {
    vi.spyOn(api, 'getTelemetrySetting').mockReturnValue(new Promise(() => {}));
    const open = vi.fn();
    useSetup.setState({ open } as never);
    const onDone = vi.fn();
    render(<AboutSection onDone={onDone} />);
    fireEvent.click(screen.getByRole('button', { name: 'Re-run setup wizard' }));
    expect(open).toHaveBeenCalled();
    expect(onDone).toHaveBeenCalled();
  });
});
