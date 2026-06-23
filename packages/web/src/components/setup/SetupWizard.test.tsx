import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, test, expect, beforeEach } from 'vitest';

vi.mock('qrcode', () => ({ default: { toDataURL: async () => 'data:image/png;base64,stub' } }));

const getSetupState = vi.fn();
const completeSetup = vi.fn().mockResolvedValue({ ok: true });
const recheckProviders = vi.fn();
vi.mock('../../api/client', () => ({ api: {
  getSetupState: () => getSetupState(),
  completeSetup: () => completeSetup(),
  recheckProviders: () => recheckProviders(),
  recheckTailscale: () => Promise.resolve({ installed: false, running: false }),
} }));

import { SetupWizard } from './SetupWizard';

beforeEach(() => { getSetupState.mockReset(); completeSetup.mockClear(); });

test('renders nothing when not first run', async () => {
  getSetupState.mockResolvedValue({ firstRun: false, providers: [], tailscale: { installed: false, running: false }, secrets: { connected: false } });
  const { container } = render(<SetupWizard />);
  await waitFor(() => expect(getSetupState).toHaveBeenCalled());
  expect(container.textContent).not.toMatch(/Set up Dispatch/);
});

test('shows the Agents step on first run with provider badges', async () => {
  getSetupState.mockResolvedValue({ firstRun: true, providers: [{ name: 'claude', installed: true, signedIn: true }, { name: 'codex', installed: false, signedIn: false }], tailscale: { installed: false, running: false }, secrets: { connected: false } });
  render(<SetupWizard />);
  // Codex is signed out, so its install command (unique) renders once loaded.
  await waitFor(() => expect(screen.getByText(/npm i -g @openai\/codex/)).toBeInTheDocument());
  expect(screen.getByText('Set up Dispatch')).toBeInTheDocument();
});

test('mobile step shows the tailnet URL when running', async () => {
  getSetupState.mockResolvedValue({ firstRun: true, providers: [], tailscale: { installed: true, running: true, dnsName: 'my-mac.ts.net', url: 'http://my-mac.ts.net:3456' }, secrets: { connected: false } });
  render(<SetupWizard />);
  await waitFor(() => expect(screen.getByText('Set up Dispatch')).toBeInTheDocument());
  fireEvent.click(screen.getByText('Continue')); // agents → mobile
  await waitFor(() => expect(screen.getByText('http://my-mac.ts.net:3456')).toBeInTheDocument());
});
