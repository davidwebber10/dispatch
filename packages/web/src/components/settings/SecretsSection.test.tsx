import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { vi, test, expect, afterEach, beforeEach } from 'vitest';
import { SecretsSection } from './SecretsSection';
import { useSecrets } from '../../stores/secrets';
import { api } from '../../api/client';

beforeEach(() => {
  useSecrets.setState({ status: null, secrets: [], projects: [], configs: [] });
  vi.spyOn(api, 'getSecretsStatus').mockResolvedValue({ connected: true, project: 'acme', config: 'dev', enabled: true, readOnly: false });
  vi.spyOn(api, 'listSecrets').mockResolvedValue([
    { name: 'API_KEY' },
    { name: 'DB_URL' },
  ]);
  vi.spyOn(api, 'getSecretValue').mockImplementation(async (n: string) => ({ API_KEY: 'sk-live-1', DB_URL: 'postgres://x' } as Record<string, string>)[n]);
  vi.spyOn(api, 'listDopplerConfigs').mockResolvedValue([]);
});
afterEach(() => vi.restoreAllMocks());

test('masks values until revealed; reveal-all toggles every row', async () => {
  render(<SecretsSection />);
  await waitFor(() => expect(screen.getByText('API_KEY')).toBeInTheDocument());
  expect(screen.getAllByText('••••••••••••')).toHaveLength(2);
  expect(screen.queryByText('sk-live-1')).not.toBeInTheDocument();

  expect(api.getSecretValue).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: 'Reveal all values' }));
  await waitFor(() => expect(screen.getByText('sk-live-1')).toBeInTheDocument());
  expect(screen.getByText('postgres://x')).toBeInTheDocument();
  expect(screen.queryByText('••••••••••••')).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Hide all values' }));
  expect(screen.getAllByText('••••••••••••')).toHaveLength(2);
});

test('fetches one value only when that row is revealed', async () => {
  render(<SecretsSection />);
  await waitFor(() => expect(screen.getByText('API_KEY')).toBeInTheDocument());
  fireEvent.click(screen.getAllByTitle('Reveal value')[0]);
  await waitFor(() => expect(screen.getByText('sk-live-1')).toBeInTheDocument());
  expect(api.getSecretValue).toHaveBeenCalledTimes(1);
  expect(api.getSecretValue).toHaveBeenCalledWith('API_KEY');
  expect(screen.queryByText('postgres://x')).not.toBeInTheDocument();
});

test('read-only hides delete + add and shows the banner', async () => {
  vi.spyOn(api, 'getSecretsStatus').mockResolvedValue({ connected: true, project: 'acme', config: 'dev', enabled: true, readOnly: true });
  render(<SecretsSection />);
  await waitFor(() => expect(screen.getByText('API_KEY')).toBeInTheDocument());
  expect(screen.queryByTitle('Delete secret')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Add variable' })).not.toBeInTheDocument();
  expect(screen.getByText(/Turn off read-only to add, edit, or delete variables/)).toBeInTheDocument();
});

test('a reloaded list drops the fetched values, so the next reveal asks again', async () => {
  render(<SecretsSection />);
  await waitFor(() => expect(screen.getByText('API_KEY')).toBeInTheDocument());
  fireEvent.click(screen.getAllByTitle('Reveal value')[0]);
  await waitFor(() => expect(screen.getByText('sk-live-1')).toBeInTheDocument());
  vi.mocked(api.getSecretValue).mockImplementation(async () => 'sk-live-2');
  fireEvent.click(screen.getByRole('button', { name: 'Re-sync' }));
  await waitFor(() => expect(screen.queryByText('sk-live-1')).not.toBeInTheDocument());
  fireEvent.click(screen.getAllByTitle('Reveal value')[0]);
  await waitFor(() => expect(screen.getByText('sk-live-2')).toBeInTheDocument());
});

test('a value that arrives after the list was reloaded is discarded', async () => {
  render(<SecretsSection />);
  await waitFor(() => expect(screen.getByText('API_KEY')).toBeInTheDocument());
  let release!: (v: string) => void;
  vi.mocked(api.getSecretValue).mockImplementationOnce(() => new Promise<string>((r) => { release = r; }));
  fireEvent.click(screen.getAllByTitle('Reveal value')[0]);
  fireEvent.click(screen.getByRole('button', { name: 'Re-sync' }));
  await waitFor(() => expect(api.listSecrets).toHaveBeenCalledTimes(2));
  release('stale-value');
  await new Promise((r) => setTimeout(r, 20));
  expect(screen.queryByText('stale-value')).not.toBeInTheDocument();
  expect(screen.getAllByText('••••••••••••')).toHaveLength(2);
});

test('connected: a Doppler group (connection, read-only) and a Variables group with a row per secret', async () => {
  render(<SecretsSection />);
  await waitFor(() => expect(screen.getByText('API_KEY')).toBeInTheDocument());
  const doppler = screen.getByRole('group', { name: 'Doppler' });
  expect(within(doppler).getByText('acme / dev')).toBeInTheDocument();
  expect(within(doppler).getByText('Connected')).toBeInTheDocument();
  expect(within(doppler).getByRole('switch', { name: 'Read-only' })).toHaveAttribute('aria-checked', 'false');
  const vars = screen.getByRole('group', { name: 'Variables' });
  expect(within(vars).getAllByTestId('secret-row')).toHaveLength(2);
  expect(within(vars).getByRole('button', { name: 'Re-sync' })).toBeInTheDocument();
  expect(screen.getByText('2 variables')).toBeInTheDocument();
  // No old mono banner, no column heads.
  expect(screen.queryByText('SECRETS (DOPPLER)')).not.toBeInTheDocument();
  expect(screen.queryByText('NAME')).not.toBeInTheDocument();
});

test('the read-only switch keeps the stored token and flips only the flag', async () => {
  const set = vi.spyOn(api, 'setDopplerConnection').mockResolvedValue({ connected: true, project: 'acme', config: 'dev', enabled: true, readOnly: true });
  render(<SecretsSection />);
  await waitFor(() => expect(screen.getByText('API_KEY')).toBeInTheDocument());
  fireEvent.click(screen.getByRole('switch', { name: 'Read-only' }));
  await waitFor(() => expect(set).toHaveBeenCalledWith({ token: '', project: 'acme', config: 'dev', enabled: true, readOnly: true }));
});

test('delete asks first, then deletes in Doppler', async () => {
  const del = vi.spyOn(api, 'deleteSecret').mockResolvedValue(undefined as never);
  render(<SecretsSection />);
  await waitFor(() => expect(screen.getByText('API_KEY')).toBeInTheDocument());
  fireEvent.click(screen.getAllByTitle('Delete secret')[0]);
  expect(del).not.toHaveBeenCalled();
  const dialog = screen.getByRole('alertdialog');
  expect(dialog).toHaveTextContent(/acme\/dev/);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete secret' }));
  await waitFor(() => expect(del).toHaveBeenCalledWith('API_KEY'));
});

test('Add variable opens a sheet that saves the secret', async () => {
  const set = vi.spyOn(api, 'setSecret').mockResolvedValue(undefined as never);
  render(<SecretsSection />);
  await waitFor(() => expect(screen.getByText('API_KEY')).toBeInTheDocument());
  expect(screen.queryByLabelText('Value')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Add variable' }));
  const save = screen.getByRole('button', { name: 'Save variable' });
  expect(save).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'NEW_KEY' } });
  fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'v1' } });
  fireEvent.click(save);
  await waitFor(() => expect(set).toHaveBeenCalledWith({ name: 'NEW_KEY', value: 'v1' }));
  await waitFor(() => expect(screen.queryByLabelText('Value')).not.toBeInTheDocument());
});

test('Disconnect sits at the bottom and asks first', async () => {
  const dis = vi.spyOn(api, 'disconnectDoppler').mockResolvedValue({ connected: false, project: null, config: null, enabled: true, readOnly: false } as never);
  render(<SecretsSection />);
  await waitFor(() => expect(screen.getByText('API_KEY')).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: 'Disconnect Doppler' }));
  expect(dis).not.toHaveBeenCalled();
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Disconnect' }));
  await waitFor(() => expect(dis).toHaveBeenCalled());
});

test('not connected: a Doppler group with the token row; Connect verifies it, then the project picker shows', async () => {
  vi.spyOn(api, 'getSecretsStatus').mockResolvedValue({ connected: false, project: null, config: null, enabled: true, readOnly: false });
  const set = vi.spyOn(api, 'setDopplerConnection').mockResolvedValue({ connected: false, project: null, config: null, enabled: true, readOnly: false });
  vi.spyOn(api, 'listDopplerProjects').mockResolvedValue([{ slug: 'acme', name: 'Acme' }] as never);
  render(<SecretsSection />);
  const group = await screen.findByRole('group', { name: 'Doppler' });
  expect(screen.getByTestId('settings-intro')).toBeInTheDocument();
  const connect = within(group).getByRole('button', { name: 'Connect' });
  expect(connect).toBeDisabled();
  fireEvent.change(within(group).getByLabelText('Doppler service token'), { target: { value: 'dp.st.abc' } });
  expect(connect).toBeEnabled();
  expect(screen.queryByRole('combobox', { name: 'Doppler project' })).not.toBeInTheDocument();
  fireEvent.click(connect);
  await waitFor(() => expect(set).toHaveBeenCalledWith({ token: 'dp.st.abc', project: '', config: '', enabled: true, readOnly: false }));
  expect(await screen.findByRole('combobox', { name: 'Doppler project' })).toBeInTheDocument();
  expect(screen.queryByRole('group', { name: 'Variables' })).not.toBeInTheDocument();
});

test('a bad token says so', async () => {
  vi.spyOn(api, 'getSecretsStatus').mockResolvedValue({ connected: false, project: null, config: null, enabled: true, readOnly: false });
  vi.spyOn(api, 'setDopplerConnection').mockRejectedValue(new Error('Invalid Doppler token'));
  render(<SecretsSection />);
  const group = await screen.findByRole('group', { name: 'Doppler' });
  fireEvent.change(within(group).getByLabelText('Doppler service token'), { target: { value: 'nope' } });
  fireEvent.click(within(group).getByRole('button', { name: 'Connect' }));
  expect(await screen.findByText(/Could not connect/)).toBeInTheDocument();
});

// W1-C (engineering program v4.5.0): which threads get the Doppler token in their environment.
const connected = (tokenScope: 'all' | 'opted-in') => ({ connected: true, project: 'acme', config: 'dev', enabled: true, readOnly: false, tokenScope });

test('shows the scope select and saves it', async () => {
  vi.spyOn(api, 'getSecretsStatus').mockResolvedValue(connected('all'));
  const set = vi.spyOn(api, 'setDopplerConnection').mockResolvedValue(connected('opted-in'));
  render(<SecretsSection />);
  await waitFor(() => expect(screen.getByText('API_KEY')).toBeInTheDocument());
  const doppler = screen.getByRole('group', { name: 'Doppler' });
  const select = within(doppler).getByRole('combobox', { name: 'Give the Doppler token to' });
  expect(select).toHaveTextContent('Every thread');

  fireEvent.click(select);
  const options = screen.getAllByRole('option').map((o) => o.textContent);
  expect(options).toEqual(['Every thread', 'Only threads that I turn on']);
  fireEvent.click(screen.getByRole('option', { name: 'Only threads that I turn on' }));
  // Only the scope is sent: the token, the project and the config stay as the daemon has them.
  await waitFor(() => expect(set).toHaveBeenCalledWith({ tokenScope: 'opted-in' }));
  await waitFor(() => expect(within(doppler).getByRole('combobox', { name: 'Give the Doppler token to' })).toHaveTextContent('Only threads that I turn on'));
  expect(screen.getByText(/takes effect when a thread next starts/i)).toBeInTheDocument();
});

test('with scope all: one line of advice with a button that changes the scope', async () => {
  vi.spyOn(api, 'getSecretsStatus').mockResolvedValue(connected('all'));
  const set = vi.spyOn(api, 'setDopplerConnection').mockResolvedValue(connected('opted-in'));
  render(<SecretsSection />);
  await waitFor(() => expect(screen.getByText('API_KEY')).toBeInTheDocument());
  const advice = screen.getByTestId('token-scope-advice');
  expect(advice).toHaveTextContent(/Every thread can read the Doppler token/);
  fireEvent.click(within(advice).getByRole('button', { name: 'Limit to threads that I turn on' }));
  await waitFor(() => expect(set).toHaveBeenCalledWith({ tokenScope: 'opted-in' }));
  await waitFor(() => expect(screen.queryByTestId('token-scope-advice')).not.toBeInTheDocument());
});

test('with scope opted-in: no advice, and the select can go back to every thread', async () => {
  vi.spyOn(api, 'getSecretsStatus').mockResolvedValue(connected('opted-in'));
  const set = vi.spyOn(api, 'setDopplerConnection').mockResolvedValue(connected('all'));
  render(<SecretsSection />);
  await waitFor(() => expect(screen.getByText('API_KEY')).toBeInTheDocument());
  expect(screen.queryByTestId('token-scope-advice')).not.toBeInTheDocument();
  expect(screen.getByText(/thread menu/i)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('combobox', { name: 'Give the Doppler token to' }));
  fireEvent.click(screen.getByRole('option', { name: 'Every thread' }));
  await waitFor(() => expect(set).toHaveBeenCalledWith({ tokenScope: 'all' }));
});

test('a scope change that fails says so and keeps the old value', async () => {
  vi.spyOn(api, 'getSecretsStatus').mockResolvedValue(connected('all'));
  vi.spyOn(api, 'setDopplerConnection').mockRejectedValue(new Error('nope'));
  render(<SecretsSection />);
  await waitFor(() => expect(screen.getByText('API_KEY')).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: 'Limit to threads that I turn on' }));
  await waitFor(() => expect(screen.getByText('Could not change the token scope.')).toBeInTheDocument());
  expect(screen.getByRole('combobox', { name: 'Give the Doppler token to' })).toHaveTextContent('Every thread');
});

test('the read-only switch does not send or change the scope', async () => {
  vi.spyOn(api, 'getSecretsStatus').mockResolvedValue(connected('opted-in'));
  const set = vi.spyOn(api, 'setDopplerConnection').mockResolvedValue({ ...connected('opted-in'), readOnly: true });
  render(<SecretsSection />);
  await waitFor(() => expect(screen.getByText('API_KEY')).toBeInTheDocument());
  fireEvent.click(screen.getByRole('switch', { name: 'Read-only' }));
  await waitFor(() => expect(set).toHaveBeenCalledWith({ token: '', project: 'acme', config: 'dev', enabled: true, readOnly: true }));
});
