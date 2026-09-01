import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openFileTab } from './openFileTab';
import { api } from '../api/client';
import { useTabs } from '../stores/tabs';
import { useUI } from '../stores/ui';

vi.mock('../api/client', () => ({
  api: { createTerminal: vi.fn().mockResolvedValue({ id: 'ft-new' }) },
}));

const fileTab = { id: 'ft-1', sessionId: 's1', type: 'file', label: 'a.ts', config: { path: '/x/a.ts' } };

beforeEach(() => {
  vi.clearAllMocks();
  useTabs.setState({ byProject: { s1: [fileTab] }, loading: {} } as never);
  vi.spyOn(useTabs.getState(), 'loadTabs').mockResolvedValue(undefined as never);
  vi.spyOn(useTabs.getState(), 'openTab').mockImplementation(() => {});
  useUI.setState({ pendingOpenTab: null } as never);
});

describe('openFileTab', () => {
  it('reuses an existing file tab for the same path instead of creating a duplicate', async () => {
    await openFileTab('s1', '/x/a.ts', { focus: false });
    expect(api.createTerminal).not.toHaveBeenCalled();
    expect(useTabs.getState().openTab).toHaveBeenCalledWith('ft-1');
  });

  it('creates the file tab when none exists for the path', async () => {
    await openFileTab('s1', '/x/b.ts', { focus: false });
    expect(api.createTerminal).toHaveBeenCalledWith('s1', { type: 'file', label: 'b.ts', config: { path: '/x/b.ts' } });
    expect(useTabs.getState().openTab).toHaveBeenCalledWith('ft-new');
  });

  it('focus:true also requests navigation to the tab (the ChatView behavior)', async () => {
    await openFileTab('s1', '/x/a.ts', { focus: true });
    expect(useUI.getState().pendingOpenTab).toBe('ft-1');
  });

  it('focus:false opens the tab but NEVER navigates — the Control Plane stays put', async () => {
    await openFileTab('s1', '/x/a.ts', { focus: false });
    expect(useUI.getState().pendingOpenTab).toBeNull();
  });
});
