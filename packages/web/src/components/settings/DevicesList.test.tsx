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

describe('<DevicesList>', () => {
  it('lists devices, marks this one, and says how each signed in', async () => {
    vi.mocked(api.getDevices).mockResolvedValue(list());
    render(<DevicesList now={() => NOW} reload={reload} />);
    const rows = await screen.findAllByTestId('device-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText('Mac (Chrome)')).toBeInTheDocument();
    expect(within(rows[0]).getByText('This device')).toBeInTheDocument();
    expect(within(rows[0]).getByText(/access token/i)).toBeInTheDocument();
    expect(within(rows[1]).queryByText('This device')).not.toBeInTheDocument();
    expect(within(rows[1]).getByText(/sign-in code/i)).toBeInTheDocument();
    expect(within(rows[1]).getByText(/192\.168\.1\.9/)).toBeInTheDocument();
    expect(within(rows[1]).getByText(/last active 5m ago/i)).toBeInTheDocument();
  });

  it('labels a device from before the device list', async () => {
    vi.mocked(api.getDevices).mockResolvedValue(list({ devices: [dev({ signedInVia: 'earlier' })], currentDeviceId: null }));
    render(<DevicesList now={() => NOW} reload={reload} />);
    expect(await screen.findByText(/before the device list/i)).toBeInTheDocument();
  });

  it('when this browser is not a device (local), says so', async () => {
    vi.mocked(api.getDevices).mockResolvedValue(list({ currentDeviceId: null, devices: [dev({})] }));
    render(<DevicesList now={() => NOW} reload={reload} />);
    expect(await screen.findByText(/signed in by being on this computer|needs no sign-in/i)).toBeInTheDocument();
  });

  it('revokes another device after a confirm, then reloads the list', async () => {
    vi.mocked(api.getDevices).mockResolvedValueOnce(list()).mockResolvedValueOnce(list({ devices: list().devices.slice(0, 1) }));
    vi.mocked(api.revokeDevice).mockResolvedValue(undefined);
    render(<DevicesList now={() => NOW} reload={reload} />);
    const rows = await screen.findAllByTestId('device-row');
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Revoke' }));
    expect(api.revokeDevice).not.toHaveBeenCalled(); // asks first
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Yes, revoke' }));
    await waitFor(() => expect(api.revokeDevice).toHaveBeenCalledWith('id1'));
    await waitFor(() => expect(screen.getAllByTestId('device-row')).toHaveLength(1));
    expect(reload).not.toHaveBeenCalled();
  });

  it('cancel keeps the device', async () => {
    vi.mocked(api.getDevices).mockResolvedValue(list());
    render(<DevicesList now={() => NOW} reload={reload} />);
    const rows = await screen.findAllByTestId('device-row');
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Revoke' }));
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Cancel' }));
    expect(api.revokeDevice).not.toHaveBeenCalled();
    expect(within(rows[1]).getByRole('button', { name: 'Revoke' })).toBeInTheDocument();
  });

  it('revoking this device warns about it and reloads to the sign-in page', async () => {
    vi.mocked(api.getDevices).mockResolvedValue(list());
    vi.mocked(api.revokeDevice).mockResolvedValue(undefined);
    render(<DevicesList now={() => NOW} reload={reload} />);
    const rows = await screen.findAllByTestId('device-row');
    fireEvent.click(within(rows[0]).getByRole('button', { name: 'Sign out this device' }));
    expect(within(rows[0]).getByText(/sign you out here/i)).toBeInTheDocument();
    fireEvent.click(within(rows[0]).getByRole('button', { name: 'Yes, sign out' }));
    await waitFor(() => expect(api.revokeDevice).toHaveBeenCalledWith('me'));
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it('renames a device', async () => {
    vi.mocked(api.getDevices).mockResolvedValue(list());
    vi.mocked(api.renameDevice).mockResolvedValue(undefined);
    render(<DevicesList now={() => NOW} reload={reload} />);
    const rows = await screen.findAllByTestId('device-row');
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Rename' }));
    const input = within(rows[1]).getByLabelText('Device name');
    fireEvent.change(input, { target: { value: 'Jason phone' } });
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.renameDevice).toHaveBeenCalledWith('id1', 'Jason phone'));
  });

  it('offers to end sign-ins from before the device list, with a confirm', async () => {
    vi.mocked(api.getDevices).mockResolvedValue(list({ legacyOpen: true }));
    vi.mocked(api.endLegacyDevices).mockResolvedValue(undefined);
    render(<DevicesList now={() => NOW} reload={reload} />);
    await screen.findAllByTestId('device-row');
    fireEvent.click(screen.getByRole('button', { name: 'Sign out devices not in this list' }));
    expect(api.endLegacyDevices).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, sign them out' }));
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
    const rows = await screen.findAllByTestId('device-row');
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Revoke' }));
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Yes, revoke' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not revoke/i);
  });
});
