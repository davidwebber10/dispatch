// While the picked harness is not installed, the window shows the install card and no field that
// has no use before the install (owner, 2026-11-27).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NewThreadModal } from './NewThreadModal';
import { api } from '../../api/client';
import { useProjects } from '../../stores/projects';
import { useTabs } from '../../stores/tabs';
import { pickOption, selectedText } from '../../test/select';

vi.mock('../../api/client', () => ({
  api: {
    createTerminal: vi.fn().mockResolvedValue({ id: 't-new' }),
    recentCcSessions: vi.fn().mockResolvedValue([]),
    recentCodexSessions: vi.fn().mockResolvedValue([]),
    recheckProviders: vi.fn(),
    installProvider: vi.fn(),
    getHarnessSettings: vi.fn().mockResolvedValue({ settings: {}, opencodeKey: { secret: 'K', present: true }, opencodeModels: [] }),
    getAccounts: vi.fn().mockRejectedValue(new Error('no accounts route')),
    getGitStatus: vi.fn().mockResolvedValue({ branch: null, files: [] }),
  },
}));

const HARNESSES = [['codex', 'Codex'], ['grok', 'Grok'], ['opencode', 'OpenCode']] as const;
const status = (name: string, installed: boolean) => ({ name, installed, signedIn: installed });
const all = (missing?: string) => ['claude', 'codex', 'grok', 'opencode'].map((n) => status(n, n !== missing));
const projectField = () => screen.queryByRole('combobox', { name: 'Project' });

beforeEach(() => {
  vi.clearAllMocks();
  useProjects.setState({ sessions: [{ id: 's1', name: 'Alpha' }, { id: 's2', name: 'Beta' }] } as never);
  useTabs.setState({ byProject: {}, loading: {} } as never);
  vi.spyOn(useTabs.getState(), 'loadTabs').mockResolvedValue(undefined as never);
});

const open = () => render(<NewThreadModal sessionId="s1" pickProject onClose={() => {}} onCreated={() => {}} />);

describe.each(HARNESSES)('NewThreadModal install card: %s', (name, label) => {
  it('hides the project, the model and Start while the harness is not installed', async () => {
    (api.recheckProviders as any).mockResolvedValue(all(name));
    open();
    fireEvent.click(await screen.findByRole('button', { name: `${label} Install` }));
    expect(await screen.findByText(new RegExp(`${label} isn't installed`))).toBeInTheDocument();
    expect(projectField()).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Model')).not.toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /start new thread/i })).not.toBeInTheDocument();
  });

  it('brings the project back after the install, with the same pick', async () => {
    (api.recheckProviders as any).mockResolvedValue(all(name));
    (api.installProvider as any).mockResolvedValue({ ok: true, output: '', status: status(name, true), loginCommand: '' });
    open();
    // Wait for the probe, then pick the second project while an installed harness is selected.
    await screen.findByRole('button', { name: `${label} Install` });
    pickOption('Project', 'Beta');
    fireEvent.click(screen.getByRole('button', { name: `${label} Install` }));
    expect(projectField()).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: `Install ${label}` }));
    expect(await screen.findByRole('button', { name: /start new thread/i })).toBeInTheDocument();
    expect(selectedText('Project')).toBe('Beta');
  });

  it('shows the project for the harness when it is installed', async () => {
    (api.recheckProviders as any).mockResolvedValue(all());
    open();
    fireEvent.click(await screen.findByRole('button', { name: label }));
    expect(projectField()).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /start new thread/i })).toBeInTheDocument();
  });
});
