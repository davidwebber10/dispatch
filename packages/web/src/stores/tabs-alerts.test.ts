import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useTabs } from './tabs';
import { api } from '../api/client';
import type { Terminal } from '../api/types';

vi.mock('../api/client', () => ({
  api: {
    setTerminalAlerts: vi.fn().mockResolvedValue({}),
    listTerminals: vi.fn().mockResolvedValue([]),
  },
}));

const thread = (over: Partial<Terminal> = {}): Terminal => ({
  id: 't1', sessionId: 's1', type: 'claude-code', label: 'Claude Code 37',
  pid: null, externalId: null, workingDir: null, archivedAt: null, sortOrder: 0,
  status: 'waiting', config: { transport: 'structured' }, createdAt: '', lastActivityAt: '',
  ...over,
} as Terminal);

beforeEach(() => {
  vi.clearAllMocks();
  useTabs.setState({ byProject: { s1: [thread()] }, tabSession: { t1: 's1' } });
});

describe('useTabs.setAlertsEnabled', () => {
  it('optimistically sets config.alertsEnabled and calls the dedicated endpoint', async () => {
    await useTabs.getState().setAlertsEnabled('t1', true);
    const t = useTabs.getState().byProject.s1[0];
    expect(t.config).toMatchObject({ alertsEnabled: true, transport: 'structured' });
    expect(api.setTerminalAlerts).toHaveBeenCalledWith('t1', true);
  });

  it('deletes the key on disable', async () => {
    useTabs.setState({ byProject: { s1: [thread({ config: { alertsEnabled: true } as any })] } });
    await useTabs.getState().setAlertsEnabled('t1', false);
    expect(useTabs.getState().byProject.s1[0].config).not.toHaveProperty('alertsEnabled');
  });

  it('reloads server truth when the call fails', async () => {
    (api.setTerminalAlerts as any).mockRejectedValueOnce(new Error('boom'));
    await useTabs.getState().setAlertsEnabled('t1', true);
    expect(api.listTerminals).toHaveBeenCalledWith('s1');
  });
});
