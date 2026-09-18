import { it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NewThreadModal } from './NewThreadModal';
import { HARNESSES } from '../../lib/harnesses';
import { api } from '../../api/client';
import { useTabs } from '../../stores/tabs';
vi.mock('../../api/client', () => ({ api: {
  getHarnessCapabilities: vi.fn(),
  recheckProviders: vi.fn().mockResolvedValue([{ name: 'codex', installed: true, signedIn: true }]),
  getHarnessSettings: vi.fn().mockResolvedValue({ settings: {}, opencodeKey: { present: true } }),
  recentCodexSessions: vi.fn().mockResolvedValue([]), recentCcSessions: vi.fn().mockResolvedValue([]),
  createTerminal: vi.fn().mockResolvedValue({ id: 'new' }),
} }));
it('uses the running server capabilities for offered transports and submitted config', async () => {
  vi.mocked(api.getHarnessCapabilities).mockResolvedValue(HARNESSES.map(h => ({ ...h,
    modes: h.type === 'codex' ? ['cli'] : h.type === 'opencode' ? [] : h.modes,
    capabilities: { resume: false, branch: false, permissions: false, telemetry: { structured: false, pty: false } },
  })));
  vi.spyOn(useTabs.getState(),'loadTabs').mockResolvedValue(undefined);
  render(<NewThreadModal sessionId="p" onClose={() => {}} onCreated={() => {}} />);
  await waitFor(() => expect(screen.queryByRole('button',{ name: 'OpenCode' })).not.toBeInTheDocument());
  fireEvent.click(screen.getByRole('button',{ name: 'Codex' }));
  expect(screen.getByRole('button',{ name: 'Pretty mode' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button',{ name: /start new thread/i }));
  await waitFor(() => expect(api.createTerminal).toHaveBeenCalledWith('p',{ type: 'codex', externalId: undefined }));
});

it('uses daemon-owned OpenCode models with the running server capabilities', async () => {
  vi.mocked(api.createTerminal).mockClear();
  vi.mocked(api.getHarnessCapabilities).mockResolvedValue(HARNESSES.map(h => ({ ...h,
    capabilities: { resume: false, branch: false, permissions: true, telemetry: { structured: true, pty: false } },
  })));
  vi.mocked(api.getHarnessSettings).mockResolvedValue({ settings: {},
    opencodeKey: { secret: 'OPENROUTER_API_KEY', present: true },
    opencodeModels: [{ label: 'My model', model: 'openrouter/test/custom' }],
  });
  vi.spyOn(useTabs.getState(), 'loadTabs').mockResolvedValue(undefined);
  render(<NewThreadModal sessionId="p" onClose={() => {}} onCreated={() => {}} />);
  await waitFor(() => expect(screen.getByRole('button', { name: /start new thread/i })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'OpenCode' }));
  expect(screen.getByRole('combobox', { name: 'Model' })).toHaveTextContent('My model');
  expect(screen.getByRole('button', { name: 'CLI mode' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: /start new thread/i }));
  await waitFor(() => expect(api.createTerminal).toHaveBeenCalledWith('p', {
    type: 'opencode', externalId: undefined,
    config: { transport: 'structured', model: 'openrouter/test/custom' },
  }));
});
