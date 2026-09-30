import { render, screen, waitFor } from '@testing-library/react';
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
  { ...base, id: '1', name: 'linear', type: 'remote', url: 'https://mcp.linear.app/sse', enabled: true },
  { ...base, id: '2', name: 'sentry', type: 'remote', url: 'https://mcp.sentry.dev/sse', enabled: false },
  { ...base, id: '3', name: 'files', type: 'stdio', command: 'npx', args: ['-y', 'srv'], url: null, enabled: true },
];

test('groups servers under ACTIVE and OFF with a summary line', async () => {
  vi.spyOn(api, 'listIntegrations').mockResolvedValue({ integrations: INTEGRATIONS });
  render(<IntegrationsSection />);
  await waitFor(() => expect(screen.getByText('linear')).toBeInTheDocument());
  expect(screen.getByText('ACTIVE')).toBeInTheDocument();
  expect(screen.getByText('OFF')).toBeInTheDocument();
  expect(screen.getByText(/3 servers · 2 on/)).toBeInTheDocument();
  expect(screen.getAllByText('REMOTE')).toHaveLength(2);
  expect(screen.getByText('LOCAL')).toBeInTheDocument();
  expect(screen.getByText('npx -y srv')).toBeInTheDocument();
});

test('explains ${NAME} refs with the connected Doppler project/config, without loading secret values', async () => {
  vi.spyOn(api, 'listIntegrations').mockResolvedValue({ integrations: [] });
  const listSecrets = vi.spyOn(api, 'listSecrets').mockResolvedValue([]);
  render(<IntegrationsSection />);
  await waitFor(() => expect(screen.getByText(/Dispatch reads NAME from Doppler \(acme\/dev\) when the server starts/)).toBeInTheDocument());
  expect(screen.getByText(/Write \$\{NAME\} in a header or env value\./)).toBeInTheDocument();
  expect(screen.getByText(/the value never appears in a command line or a config file/)).toBeInTheDocument();
  expect(screen.queryByText(/servers inherit your session env/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Doppler is not connected/)).not.toBeInTheDocument();
  expect(listSecrets).not.toHaveBeenCalled();
});

test('hints when Doppler is not connected', async () => {
  vi.spyOn(api, 'listIntegrations').mockResolvedValue({ integrations: [] });
  vi.spyOn(api, 'getSecretsStatus').mockResolvedValue({ connected: false, project: null, config: null, enabled: true, readOnly: false });
  render(<IntegrationsSection />);
  await waitFor(() => expect(screen.getByText(/Doppler is not connected/)).toBeInTheDocument());
  expect(screen.getByText(/Connect it under Secrets/)).toBeInTheDocument();
});

test('renders only non-empty groups', async () => {
  vi.spyOn(api, 'listIntegrations').mockResolvedValue({ integrations: INTEGRATIONS.filter((i) => i.enabled) });
  render(<IntegrationsSection />);
  await waitFor(() => expect(screen.getByText('linear')).toBeInTheDocument());
  expect(screen.getByText('ACTIVE')).toBeInTheDocument();
  expect(screen.queryByText('OFF')).not.toBeInTheDocument();
});
