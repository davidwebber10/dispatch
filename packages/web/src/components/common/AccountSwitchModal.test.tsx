import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AccountSwitchModal } from './AccountSwitchModal';
import { ThreadMenu } from '../sidebar/ThreadMenu';
import { DetailsPane } from '../inspector/DetailsPane';
import { api } from '../../api/client';
import { useAccounts } from '../../stores/accounts';
import { useTabs } from '../../stores/tabs';
import { useThreadStatus } from '../../stores/threadStatus';
import { useProjects } from '../../stores/projects';
import type { Terminal } from '../../api/types';

vi.mock('../../api/client', () => ({
  api: {
    getAccounts: vi.fn(),
    switchAccount: vi.fn().mockResolvedValue({}),
    getTerminal: vi.fn().mockResolvedValue(null),
    getGitInfo: vi.fn().mockResolvedValue({ branch: null }),
    getUsageLimits: vi.fn().mockResolvedValue(null),
  },
}));

const view = {
  claude: [{ id: 'cli', label: 'CLI login (this computer)', isCli: true, addedAt: null }, { id: 'work', label: 'Work', email: 'w@x.y', isCli: false, addedAt: '2026-11-06' }],
  codex: [{ id: 'cli', label: 'CLI login (this computer)', isCli: true, addedAt: null }, { id: 'cx2', label: 'Work', isCli: false, addedAt: '2026-11-06' }],
  defaults: { claude: 'cli', codex: 'cli' },
};
const tab = (over: Partial<Terminal> = {}): Terminal => ({ id: 't1', sessionId: 's1', type: 'claude-code', label: 'Fix login', pid: 1, externalId: 'e1', workingDir: null, status: 'waiting', createdAt: '', config: {}, archivedAt: null, sortOrder: 0, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  (api.getAccounts as any).mockResolvedValue(view);
  useAccounts.setState({ view: null, loading: false });
  useThreadStatus.setState({ byTerminal: {} } as any);
  useTabs.setState({ byProject: { s1: [tab()] } } as any);
  vi.spyOn(useTabs.getState(), 'loadTabs').mockResolvedValue(undefined as any);
});

describe('AccountSwitchModal', () => {
  it('lists the harness accounts, marks the current one, and switches on confirm', async () => {
    const onClose = vi.fn();
    render(<AccountSwitchModal tab={tab()} onClose={onClose} />);
    const cli = await screen.findByRole('radio', { name: /CLI login/ });
    expect(cli).toHaveAttribute('aria-checked', 'true');
    expect(cli).toHaveTextContent('current (the default)');
    const go = screen.getByRole('button', { name: 'Switch and restart' });
    expect(go).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: /Work/ }));
    expect(screen.getByRole('note')).toHaveTextContent('This thread restarts under “Work” and resumes its session.');
    fireEvent.click(go);
    await waitFor(() => expect(api.switchAccount).toHaveBeenCalledWith('t1', 'work', undefined));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('a working thread switches with force and says the turn stops; a Codex thread is told its session is fresh', async () => {
    useThreadStatus.setState({ byTerminal: { t1: { threadStatus: 'working' } } } as any);
    render(<AccountSwitchModal tab={tab({ type: 'codex' })} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('radio', { name: /Work/ }));
    expect(screen.getByRole('note')).toHaveTextContent('stops its turn');
    expect(screen.getByRole('note')).toHaveTextContent('fresh Codex session');
    fireEvent.click(screen.getByRole('button', { name: 'Switch and restart' }));
    await waitFor(() => expect(api.switchAccount).toHaveBeenCalledWith('t1', 'cx2', { force: true }));
  });

  it('a Codex Pretty thread cannot pick an added account', async () => {
    render(<AccountSwitchModal tab={tab({ type: 'codex', config: { transport: 'structured' } })} onClose={() => {}} />);
    expect(await screen.findByRole('radio', { name: /Work/ })).toBeDisabled();
  });

  it('shows the daemon error when the switch is refused', async () => {
    (api.switchAccount as any).mockRejectedValueOnce(new Error('This thread is busy'));
    render(<AccountSwitchModal tab={tab()} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('radio', { name: /Work/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Switch and restart' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This thread is busy');
  });
});

describe('Switch account… in the thread menu', () => {
  it('is a row for a Claude Code thread and opens the modal; a shell has none', async () => {
    const { rerender } = render(<ThreadMenu at={{ tab: tab(), x: 10, y: 10 }} onClose={() => {}} onBranched={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Switch account…' }));
    expect(await screen.findByRole('radio', { name: /Work/ })).toBeInTheDocument();
    rerender(<ThreadMenu at={{ tab: tab({ type: 'shell' }), x: 10, y: 10 }} onClose={() => {}} onBranched={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Switch account…' })).not.toBeInTheDocument();
  });
});

describe('DetailsPane account row', () => {
  it('names the account the thread runs on, "(default)" when unpinned, and offers Switch Account', async () => {
    useProjects.setState({ sessions: [{ id: 's1', name: 'Proj', workingDir: '/tmp/p', provider: 'claude-code', status: 'idle' }] } as any);
    render(<DetailsPane projectId="s1" terminalId="t1" />);
    expect(await screen.findByText('CLI login (this computer) (default)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Switch Account' }));
    expect(await screen.findByRole('radio', { name: /Work/ })).toBeInTheDocument();
  });

  it('names a pinned account plainly', async () => {
    useTabs.setState({ byProject: { s1: [tab({ config: { accountId: 'work' } })] } } as any);
    useProjects.setState({ sessions: [{ id: 's1', name: 'Proj', workingDir: '/tmp/p', provider: 'claude-code', status: 'idle' }] } as any);
    render(<DetailsPane projectId="s1" terminalId="t1" />);
    expect(await screen.findByText('Work')).toBeInTheDocument();
  });
});
