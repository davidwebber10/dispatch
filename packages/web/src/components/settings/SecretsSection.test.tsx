import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, test, expect, afterEach, beforeEach } from 'vitest';
import { SecretsSection } from './SecretsSection';
import { useSecrets } from '../../stores/secrets';
import { api } from '../../api/client';

beforeEach(() => {
  useSecrets.setState({ status: null, secrets: [], projects: [], configs: [] });
  vi.spyOn(api, 'getSecretsStatus').mockResolvedValue({ connected: true, project: 'acme', config: 'dev', enabled: true, readOnly: false });
  vi.spyOn(api, 'listSecrets').mockResolvedValue([
    { name: 'API_KEY', value: 'sk-live-1' },
    { name: 'DB_URL', value: 'postgres://x' },
  ]);
  vi.spyOn(api, 'listDopplerConfigs').mockResolvedValue([]);
});
afterEach(() => vi.restoreAllMocks());

test('masks values until revealed; reveal-all toggles every row', async () => {
  render(<SecretsSection />);
  await waitFor(() => expect(screen.getByText('API_KEY')).toBeInTheDocument());
  expect(screen.getAllByText('••••••••••••')).toHaveLength(2);
  expect(screen.queryByText('sk-live-1')).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Reveal all values' }));
  expect(screen.getByText('sk-live-1')).toBeInTheDocument();
  expect(screen.getByText('postgres://x')).toBeInTheDocument();
  expect(screen.queryByText('••••••••••••')).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Hide all values' }));
  expect(screen.getAllByText('••••••••••••')).toHaveLength(2);
});

test('read-only hides delete + add and shows the banner', async () => {
  vi.spyOn(api, 'getSecretsStatus').mockResolvedValue({ connected: true, project: 'acme', config: 'dev', enabled: true, readOnly: true });
  render(<SecretsSection />);
  await waitFor(() => expect(screen.getByText('API_KEY')).toBeInTheDocument());
  expect(screen.queryByTitle('Delete secret')).not.toBeInTheDocument();
  expect(screen.queryByText('ADD VARIABLE')).not.toBeInTheDocument();
  expect(screen.getByText(/Turn off read-only to add, edit, or delete variables/)).toBeInTheDocument();
});
