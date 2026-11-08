import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DevicesList, addressLabel } from './DevicesList';
import { api, ApiError, type DeviceList } from '../../api/client';

vi.mock('../../api/client', async (orig) => {
  const real = await orig<typeof import('../../api/client')>();
  return { ...real, api: { ...real.api, getDevices: vi.fn(), renameDevice: vi.fn(), revokeDevice: vi.fn(), endLegacyDevices: vi.fn() } };
});

const NOW = Date.parse('2026-11-03T12:00:00Z');
const dev = (over: Partial<DeviceList['devices'][number]>): DeviceList['devices'][number] => ({
  id: 'id1', name: 'iPhone (Safari)', signedInVia: 'code', createdAt: NOW - 3 * 86_400_000, lastSeenAt: NOW - 5 * 60_000,
  lastAddress: '192.168.1.9', addressKind: 'direct', current: false, ...over,
});
const list = (over: Partial<DeviceList> = {}): DeviceList => ({
  devices: [dev({ id: 'me', name: 'Mac (Chrome)', signedInVia: 'token', current: true }), dev({})],
  currentDeviceId: 'me', legacyOpen: false, ...over,
});
const reload = vi.fn();

beforeEach(() => {
  vi.mocked(api.getDevices).mockReset(); vi.mocked(api.renameDevice).mockReset();
  vi.mocked(api.revokeDevice).mockReset(); vi.mocked(api.endLegacyDevices).mockReset();
  reload.mockReset();
});

describe('addressLabel', () => {
  it('says what an address means', () => {
    expect(addressLabel('127.0.0.1', 'local')).toBe('This computer');
    expect(addressLabel('172.20.0.1', 'gateway')).toBe('Windows host (WSL)');
    expect(addressLabel('100.64.0.2', 'forwarded')).toBe('100.64.0.2 (via proxy)');
    expect(addressLabel('192.168.1.9', 'direct')).toBe('192.168.1.9');
    expect(addressLabel(null, null)).toBe('Unknown address');
  });
});

const openDevice = (row: HTMLElement) => fireEvent.click(within(row).getAllByRole('button')[0]);
const dialog = () => screen.getByRole('alertdialog');

describe('<DevicesList>', () => {
  it('lists devices as rows: the name, this device marked, and one line of when and where', async () => {
    vi.mocked(api.getDevices).mockResolvedValue(list());
    render(<DevicesList now={() => NOW} reload={reload} />);
    const rows = await screen.findAllByTestId('device-row');
    expect(rows).toHaveLength(2);
    expect(within(screen.getByRole('group', { name: 'Signed-in devices' })).getAllByTestId('device-row')).toHaveLength(2);
    expect(within(rows[0]).getByText('Mac (Chrome)')).toBeInTheDocument();
    expect(within(rows[0]).getByText('This device')).toBeInTheDocument();
    expect(within(rows[1]).queryByText('This device')).not.toBeInTheDocument();
    expect(within(rows[1]).getByText(/192\.168\.1\.9/)).toBeInTheDocument();
    expect(within(rows[1]).getByText(/last active 5m ago/i)).toBeInTheDocument();
    // No per-row buttons: Rename and Revoke live on the device's page.
    expect(within(rows[1]).queryByRole('button', { name: 'Revoke' })).toBeNull();
  });

  it("a device's page says how it signed in, where from, and when", async () => {
    vi.mocked(api.getDevices).mockResolvedValue(list());
    render(<DevicesList now={() => NOW} reload={reload} />);
    let rows = await screen.findAllByTestId('device-row');
    openDevice(rows[1]);
    const page = screen.getByTestId('device-page');
    expect(within(page).getByText(/sign-in code/i)).toBeInTheDocument();
    expect(within(page).getByText('192.168.1.9')).toBeInTheDocument();
    expect(within(page).getByText('5m ago')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Back to/ }));
    rows = await screen.findAllByTestId('device-row');
    openDevice(rows[0]);
    expect(within(screen.getByTestId('device-page')).getByText(/access token/i)).toBeInTheDocument();
  });

  it('says why own-Tailscale devices are not listed, under the list', async () => {
    vi.mocked(api.getDevices).mockResolvedValue(list());
    render(<DevicesList now={() => NOW} reload={reload} />);
    const note = await screen.findByTestId('tailscale-note');
    expect(note).toHaveTextContent('Devices on your Tailscale need no sign-in and are not listed.');
    expect(note).toHaveTextContent('Manage them in the Tailscale admin console.');
  });

  it('labels a device from before the device list', async () => {
    vi.mocked(api.getDevices).mockResolvedValue(list({ devices: [dev({ signedInVia: 'earlier' })], currentDeviceId: null }));
    render(<DevicesList now={() => NOW} reload={reload} />);
    openDevice((await screen.findAllByTestId('device-row'))[0]);
    expect(screen.getByText(/before the device list/i)).toBeInTheDocument();
  });

  it('when this browser is not a device (local), says so', async () => {
    vi.mocked(api.getDevices).mockResolvedValue(list({ currentDeviceId: null, devices: [dev({})] }));
    render(<DevicesList now={() => NOW} reload={reload} />);
    expect(await screen.findByText(/needs no sign-in, so it is not listed/i)).toBeInTheDocument();
  });

  it('with no device yet, says so in place of the card', async () => {
    vi.mocked(api.getDevices).mockResolvedValue(list({ currentDeviceId: null, devices: [] }));
    render(<DevicesList now={() => NOW} reload={reload} />);
    expect((await screen.findByText(/No device has signed in yet/)).closest('[data-testid="empty-state"]')).not.toBeNull();
  });

  it('revokes another device after a confirm, then shows the shorter list', async () => {
    vi.mocked(api.getDevices).mockResolvedValueOnce(list()).mockResolvedValueOnce(list({ devices: list().devices.slice(0, 1) }));
    vi.mocked(api.revokeDevice).mockResolvedValue(undefined);
    render(<DevicesList now={() => NOW} reload={reload} />);
    openDevice((await screen.findAllByTestId('device-row'))[1]);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke this device' }));
    expect(api.revokeDevice).not.toHaveBeenCalled(); // asks first
    expect(dialog()).toHaveTextContent(/signed out at once/i);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(api.revokeDevice).toHaveBeenCalledWith('id1'));
    await waitFor(() => expect(screen.getAllByTestId('device-row')).toHaveLength(1));
    expect(reload).not.toHaveBeenCalled();
  });

  it('cancel keeps the device', async () => {
    vi.mocked(api.getDevices).mockResolvedValue(list());
    render(<DevicesList now={() => NOW} reload={reload} />);
    openDevice((await screen.findAllByTestId('device-row'))[1]);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke this device' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    expect(api.revokeDevice).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByTestId('device-page')).toBeInTheDocument();
  });

  it('signing out this device warns about it and reloads to the sign-in page', async () => {
    vi.mocked(api.getDevices).mockResolvedValue(list());
    vi.mocked(api.revokeDevice).mockResolvedValue(undefined);
    render(<DevicesList now={() => NOW} reload={reload} />);
    openDevice((await screen.findAllByTestId('device-row'))[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out this device' }));
    expect(dialog()).toHaveTextContent(/sign you out here/i);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(api.revokeDevice).toHaveBeenCalledWith('me'));
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it("renames a device on its page", async () => {
    vi.mocked(api.getDevices).mockResolvedValue(list());
    vi.mocked(api.renameDevice).mockResolvedValue(undefined);
    render(<DevicesList now={() => NOW} reload={reload} />);
    openDevice((await screen.findAllByTestId('device-row'))[1]);
    const input = screen.getByLabelText('Device name') as HTMLInputElement;
    expect(input.value).toBe('iPhone (Safari)');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(input, { target: { value: 'Jason phone' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.renameDevice).toHaveBeenCalledWith('id1', 'Jason phone'));
  });

  it('offers to end sign-ins from before the device list, with a confirm', async () => {
    vi.mocked(api.getDevices).mockResolvedValue(list({ legacyOpen: true }));
    vi.mocked(api.endLegacyDevices).mockResolvedValue(undefined);
    render(<DevicesList now={() => NOW} reload={reload} />);
    await screen.findAllByTestId('device-row');
    fireEvent.click(screen.getByRole('button', { name: 'Sign out devices not in this list' }));
    expect(api.endLegacyDevices).not.toHaveBeenCalled();
    expect(dialog()).toHaveTextContent(/will need to sign in again/i);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Sign them out' }));
    await waitFor(() => expect(api.endLegacyDevices).toHaveBeenCalled());
  });

  it('shows no such button once older sign-ins are ended', async () => {
    vi.mocked(api.getDevices).mockResolvedValue(list({ legacyOpen: false }));
    render(<DevicesList now={() => NOW} reload={reload} />);
    await screen.findAllByTestId('device-row');
    expect(screen.queryByRole('button', { name: 'Sign out devices not in this list' })).not.toBeInTheDocument();
  });

  it('says so when the list is not available (hosted box: 404)', async () => {
    vi.mocked(api.getDevices).mockRejectedValue(new ApiError('GET /api/access/devices failed: 404', 404));
    render(<DevicesList now={() => NOW} reload={reload} />);
    expect(await screen.findByText(/not available/i)).toBeInTheDocument();
  });

  it('shows a plain error when a revoke fails', async () => {
    vi.mocked(api.getDevices).mockResolvedValue(list());
    vi.mocked(api.revokeDevice).mockRejectedValue(new ApiError('x', 500));
    render(<DevicesList now={() => NOW} reload={reload} />);
    openDevice((await screen.findAllByTestId('device-row'))[1]);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke this device' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Revoke' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not revoke/i);
  });
});
