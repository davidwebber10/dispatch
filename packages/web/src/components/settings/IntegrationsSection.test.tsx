import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { vi, test, expect, afterEach, beforeEach } from 'vitest';
import { IntegrationsSection } from './IntegrationsSection';
import { api } from '../../api/client';
import { useSecrets } from '../../stores/secrets';
import type { Integration } from '../../api/types';

beforeEach(() => {
  useSecrets.setState({ status: null, secrets: [], projects: [], configs: [] });
  vi.spyOn(api, 'getSecretsStatus').mockResolvedValue({ connected: true, project: 'acme', config: 'dev', enabled: true, readOnly: false });
});
afterEach(() => vi.restoreAllMocks());

const base = { command: null, args: [], headers: {}, env: {}, createdAt: '2026-01-01', updatedAt: '2026-01-01' };
const INTEGRATIONS: Integration[] = [
  { ...base, id: '1', name: 'linear', type: 'remote', url: 'https://mcp.linear.app/sse', enabled: true, headers: { Authorization: 'Bearer ${LINEAR_TOKEN}', 'X-Legacy': 'abc123secret' } },
  { ...base, id: '2', name: 'sentry', type: 'remote', url: 'https://mcp.sentry.dev/sse', enabled: false },
  { ...base, id: '3', name: 'files', type: 'stdio', command: 'npx', args: ['-y', 'srv'], url: null, enabled: true, env: { ROOT_DIR: '${FILES_ROOT}' } },
];
const rowNames = () => screen.getAllByTestId('integration-row').map((r) => r.getAttribute('data-name'));

test('one "Integrations" group: on ones first, then off; a row is the name, one line, and a switch', async () => {
  vi.spyOn(api, 'listIntegrations').mockResolvedValue({ integrations: INTEGRATIONS });
  render(<IntegrationsSection />);
  await waitFor(() => expect(screen.getByText('linear')).toBeInTheDocument());
  const group = screen.getByRole('group', { name: 'Integrations' });
  expect(rowNames()).toEqual(['linear', 'files', 'sentry']);
  expect(within(group).getByText('https://mcp.linear.app/sse')).toBeInTheDocument();
  expect(within(group).getByText('npx -y srv')).toBeInTheDocument();
  expect(within(group).getByRole('switch', { name: 'linear on' })).toHaveAttribute('aria-checked', 'true');
  expect(within(group).getByRole('switch', { name: 'sentry on' })).toHaveAttribute('aria-checked', 'false');
  // No chips, no counts, no "Added by" lines, no old mono headers on the list.
  expect(screen.queryByText('REMOTE')).not.toBeInTheDocument();
  expect(screen.queryByText('ACTIVE')).not.toBeInTheDocument();
  expect(screen.queryByText(/integrations · /)).not.toBeInTheDocument();
  expect(screen.queryByTestId('integration-creator')).not.toBeInTheDocument();
});

test('the switch turns an integration on or off without opening it', async () => {
  vi.spyOn(api, 'listIntegrations').mockResolvedValue({ integrations: INTEGRATIONS });
  const set = vi.spyOn(api, 'setIntegrationEnabled').mockResolvedValue(undefined as never);
  render(<IntegrationsSection />);
  await waitFor(() => expect(screen.getByText('sentry')).toBeInTheDocument());
  fireEvent.click(screen.getByRole('switch', { name: 'sentry on' }));
  await waitFor(() => expect(set).toHaveBeenCalledWith('2', true));
  expect(screen.queryByTestId('integration-page')).not.toBeInTheDocument();
});

test('explains ${NAME} refs with the connected Doppler project/config, without loading secret values', async () => {
  vi.spyOn(api, 'listIntegrations').mockResolvedValue({ integrations: INTEGRATIONS });
  const listSecrets = vi.spyOn(api, 'listSecrets').mockResolvedValue([]);
  render(<IntegrationsSection />);
  await waitFor(() => expect(screen.getByText(/Dispatch reads NAME from Doppler \(acme\/dev\) when the integration starts/)).toBeInTheDocument());
  expect(screen.getByText(/Write \$\{NAME\} in a header or env value\./)).toBeInTheDocument();
  expect(screen.getByText(/the value never appears in a command line or a config file/)).toBeInTheDocument();
  expect(screen.queryByText(/Doppler is not connected/)).not.toBeInTheDocument();
  expect(listSecrets).not.toHaveBeenCalled();
});

test('hints when Doppler is not connected', async () => {
  vi.spyOn(api, 'listIntegrations').mockResolvedValue({ integrations: INTEGRATIONS });
  vi.spyOn(api, 'getSecretsStatus').mockResolvedValue({ connected: false, project: null, config: null, enabled: true, readOnly: false });
  render(<IntegrationsSection />);
  await waitFor(() => expect(screen.getByText(/Doppler is not connected/)).toBeInTheDocument());
  expect(screen.getByText(/Connect Doppler in Settings → Secrets\./)).toBeInTheDocument();
});

test('no integrations: an empty state with an Add button in place of the card', async () => {
  vi.spyOn(api, 'listIntegrations').mockResolvedValue({ integrations: [] });
  render(<IntegrationsSection />);
  await waitFor(() => expect(screen.getByTestId('empty-state')).toBeInTheDocument());
  expect(within(screen.getByTestId('empty-state')).getByRole('button', { name: 'Add an integration…' })).toBeInTheDocument();
  expect(screen.queryByRole('group', { name: 'Integrations' })).not.toBeInTheDocument();
});

test('a row opens the integration page: who added it, the connection, and the switch', async () => {
  vi.spyOn(api, 'listIntegrations').mockResolvedValue({
    integrations: [{ ...INTEGRATIONS[0], createdBy: { kind: 'owner' } }, INTEGRATIONS[1], { ...INTEGRATIONS[2], createdBy: { kind: 'thread', terminalId: 'abcdef123456', name: 'Fix login' } }],
  });
  render(<IntegrationsSection />);
  await waitFor(() => expect(screen.getByText('linear')).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: /^linear/ }));
  const page = screen.getByTestId('integration-page');
  expect(within(page).getByTestId('integration-creator')).toHaveTextContent('Added by Owner (signed in)');
  expect(within(page).getByText('https://mcp.linear.app/sse')).toBeInTheDocument();
  // A ${NAME} reference shows; a literal value does not.
  expect(within(page).getByText('Bearer ${LINEAR_TOKEN}')).toBeInTheDocument();
  expect(within(page).queryByText('abc123secret')).not.toBeInTheDocument();
  expect(within(page).getByRole('switch', { name: 'linear on' })).toBeInTheDocument();
  expect(screen.queryByRole('group', { name: 'Integrations' })).not.toBeInTheDocument();

  fireEvent.click(within(page).getByRole('button', { name: 'Back to integrations' }));
  fireEvent.click(screen.getByRole('button', { name: /^sentry/ }));
  expect(within(screen.getByTestId('integration-page')).getByTestId('integration-creator')).toHaveTextContent('Added by Unknown');
  fireEvent.click(screen.getByRole('button', { name: 'Back to integrations' }));
  fireEvent.click(screen.getByRole('button', { name: /^files/ }));
  const files = screen.getByTestId('integration-page');
  expect(within(files).getByTestId('integration-creator')).toHaveTextContent('Added by Thread: Fix login');
  expect(within(files).getByText('npx -y srv')).toBeInTheDocument();
  expect(within(files).getByText('${FILES_ROOT}')).toBeInTheDocument();
});

test('Remove asks first, then removes and goes back to the list', async () => {
  const list = vi.spyOn(api, 'listIntegrations').mockResolvedValue({ integrations: INTEGRATIONS });
  const remove = vi.spyOn(api, 'removeIntegration').mockResolvedValue(undefined as never);
  render(<IntegrationsSection />);
  await waitFor(() => expect(screen.getByText('linear')).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: /^linear/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Remove integration' }));
  expect(remove).not.toHaveBeenCalled();
  const dialog = screen.getByRole('alertdialog');
  list.mockResolvedValue({ integrations: INTEGRATIONS.slice(1) });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Remove integration' }));
  await waitFor(() => expect(remove).toHaveBeenCalledWith('1'));
  await waitFor(() => expect(screen.queryByTestId('integration-page')).not.toBeInTheDocument());
  expect(screen.queryByText('linear')).not.toBeInTheDocument();
});

test('the add form lives in a sheet: remote by URL, or a local command', async () => {
  vi.spyOn(api, 'listIntegrations').mockResolvedValue({ integrations: INTEGRATIONS });
  const add = vi.spyOn(api, 'addIntegration').mockResolvedValue(undefined as never);
  render(<IntegrationsSection />);
  await waitFor(() => expect(screen.getByText('linear')).toBeInTheDocument());
  expect(screen.queryByLabelText('Name')).not.toBeInTheDocument(); // not open inline
  fireEvent.click(within(screen.getByRole('group', { name: 'Integrations' })).getByRole('button', { name: 'Add…' }));
  const addBtn = () => screen.getByRole('button', { name: 'Add integration' });
  expect(addBtn()).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'notion' } });
  fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://mcp.notion.com/sse' } });
  fireEvent.change(screen.getByLabelText('Headers'), { target: { value: 'Authorization=Bearer ${NOTION}' } });
  expect(addBtn()).toBeEnabled();
  fireEvent.click(addBtn());
  await waitFor(() => expect(add).toHaveBeenCalledWith({ type: 'remote', name: 'notion', url: 'https://mcp.notion.com/sse', headers: { Authorization: 'Bearer ${NOTION}' } }));
  await waitFor(() => expect(screen.queryByLabelText('Name')).not.toBeInTheDocument());

  fireEvent.click(screen.getByRole('button', { name: 'Add…' }));
  fireEvent.click(screen.getByRole('radio', { name: 'Local command' }));
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'fs' } });
  fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'npx' } });
  fireEvent.change(screen.getByLabelText('Arguments'), { target: { value: '-y @scope/fs' } });
  fireEvent.change(screen.getByLabelText('Environment'), { target: { value: 'ROOT=/tmp' } });
  fireEvent.click(addBtn());
  await waitFor(() => expect(add).toHaveBeenLastCalledWith({ type: 'stdio', name: 'fs', command: 'npx', args: ['-y', '@scope/fs'], env: { ROOT: '/tmp' } }));
});

test('a refused secret shows the daemon advice in the sheet', async () => {
  vi.spyOn(api, 'listIntegrations').mockResolvedValue({ integrations: INTEGRATIONS });
  vi.spyOn(api, 'addIntegration').mockRejectedValue(new Error('POST failed — "X" looks like a secret; use ${NAME}'));
  render(<IntegrationsSection />);
  await waitFor(() => expect(screen.getByText('linear')).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: 'Add…' }));
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'x' } });
  fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://x.dev' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add integration' }));
  await waitFor(() => expect(screen.getByText(/looks like a secret; use \$\{NAME\}/)).toBeInTheDocument());
  expect(screen.getByLabelText('Name')).toBeInTheDocument(); // the sheet stays open
});

test('Export and Import sit in their own group; an import result is a note, not an error', async () => {
  vi.spyOn(api, 'listIntegrations').mockResolvedValue({ integrations: INTEGRATIONS });
  vi.spyOn(api, 'importIntegrations').mockResolvedValue({ added: ['a'], skipped: [] } as never);
  render(<IntegrationsSection />);
  await waitFor(() => expect(screen.getByText('linear')).toBeInTheDocument());
  const backup = screen.getByRole('group', { name: 'Backup' });
  expect(within(backup).getByRole('button', { name: /^Export/ })).toBeInTheDocument();
  expect(within(backup).getByRole('button', { name: /^Import/ })).toBeInTheDocument();
  const file = new File([JSON.stringify({ version: 1, integrations: [] })], 'i.json', { type: 'application/json' });
  Object.defineProperty(file, 'text', { value: async () => JSON.stringify({ version: 1, integrations: [] }) });
  fireEvent.change(screen.getByTestId('integrations-import-file'), { target: { files: [file] } });
  const note = await screen.findByText(/Imported 1, skipped 0\./);
  expect(note.getAttribute('style') ?? '').not.toContain('status-red');
});
