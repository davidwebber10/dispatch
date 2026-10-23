import { render, screen, waitFor, fireEvent } from '@testing-library/react';
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
  expect(screen.queryByText('ADD VARIABLE')).not.toBeInTheDocument();
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
