import { render, screen, waitFor } from '@testing-library/react';
import { vi, test, expect, afterEach } from 'vitest';
import { IntegrationsSection } from './IntegrationsSection';
import { api } from '../../api/client';
import type { Integration } from '../../api/types';

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

test('renders only non-empty groups', async () => {
  vi.spyOn(api, 'listIntegrations').mockResolvedValue({ integrations: INTEGRATIONS.filter((i) => i.enabled) });
  render(<IntegrationsSection />);
  await waitFor(() => expect(screen.getByText('linear')).toBeInTheDocument());
  expect(screen.getByText('ACTIVE')).toBeInTheDocument();
  expect(screen.queryByText('OFF')).not.toBeInTheDocument();
});
