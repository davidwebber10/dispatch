import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { api } from '../api/client';
import { buildSdk } from './sdk';
import { PluginDialogs, usePluginDialogs } from './PluginDialogs';
import { useProjects } from '../stores/projects';
import { useTabs } from '../stores/tabs';
import { useAgents } from '../stores/agents';

/** SDK actions that open the schedule and new-thread dialogs pre-filled (coach plan, Task 6; coach spec section 4.1). */
beforeEach(() => {
  usePluginDialogs.setState({ schedule: null, newThreads: null });
  useProjects.setState({ sessions: [{ id: 's1', name: 'Finance', workingDir: '/w/finance' }, { id: 's2', name: 'Ops', workingDir: '/w/ops' }] as never, activeId: 's2' });
  useTabs.setState({ byProject: {}, loading: {} } as never);
  vi.spyOn(useTabs.getState(), 'loadTabs').mockResolvedValue(undefined as never);
  vi.spyOn(api, 'createSchedule').mockResolvedValue({ id: 'sch-1' } as never);
  vi.spyOn(api, 'createTerminal').mockImplementation(async () => ({ id: `t-${(api.createTerminal as unknown as { mock: { calls: unknown[] } }).mock.calls.length}` }) as never);
  vi.spyOn(api, 'sendStructuredMessage').mockResolvedValue(undefined);
  vi.spyOn(api, 'getHarnessCapabilities').mockRejectedValue(new Error('older daemon'));
  vi.spyOn(api, 'recheckProviders').mockResolvedValue([{ name: 'claude', installed: true, signedIn: true }] as never);
  vi.spyOn(api, 'getHarnessSettings').mockResolvedValue({ settings: {}, opencodeKey: { secret: 'K', present: true }, opencodeModels: [] } as never);
  vi.spyOn(api, 'getAccounts').mockRejectedValue(new Error('no accounts route'));
  vi.spyOn(api, 'recentCcSessions').mockResolvedValue([]);
  // After a save the modal reloads the automation list and selects the new one: no daemon here.
  vi.spyOn(useAgents.getState(), 'loadSchedules').mockResolvedValue(undefined);
  vi.spyOn(useAgents.getState(), 'select').mockResolvedValue(undefined as never);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('d.actions.openSchedule', () => {
  it('openSchedule opens the schedule dialog with the prompt and cron filled and creates nothing', async () => {
    render(<PluginDialogs />);
    act(() => buildSdk().actions.openSchedule({ projectId: 's1', prompt: 'Write the weekly pipeline report', cron: '0 8 * * 1', label: 'Weekly report' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('New Automation')).toBeInTheDocument();
    expect(within(dialog).getByPlaceholderText('Instructions / trigger prompt')).toHaveValue('Write the weekly pipeline report');
    expect(within(dialog).getByPlaceholderText('Automation name')).toHaveValue('Weekly report');
    expect(within(dialog).getByPlaceholderText('0 9 * * 1-5')).toHaveValue('0 8 * * 1');
    expect(within(dialog).getByRole('combobox')).toHaveValue('s1');
    expect(api.createSchedule).not.toHaveBeenCalled();
    // The person confirms: only then is it created.
    fireEvent.click(within(dialog).getByRole('button', { name: /save|create/i }));
    await waitFor(() => expect(api.createSchedule).toHaveBeenCalledTimes(1));
    expect((api.createSchedule as unknown as { mock: { calls: [{ prompt: string; recurrenceRule: string; projectId: string }][] } }).mock.calls[0][0]).toMatchObject({
      projectId: 's1', prompt: 'Write the weekly pipeline report', recurrenceRule: JSON.stringify({ type: 'cron', expr: '0 8 * * 1' }),
    });
  });

  it('with no project it opens on the open project; Cancel creates nothing', async () => {
    render(<PluginDialogs />);
    act(() => buildSdk().actions.openSchedule({ prompt: 'Summarize the inbox' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('combobox')).toHaveValue('s2');
    act(() => usePluginDialogs.getState().close());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.createSchedule).not.toHaveBeenCalled();
  });
});

describe('d.actions.openNewThreads', () => {
  it('openNewThreads with 3 prompts opens the dialog listing 3 threads', async () => {
    render(<PluginDialogs />);
    act(() => buildSdk().actions.openNewThreads({ projectId: 's1', prompts: ['Draft the Q3 summary', 'Pull the churn numbers', 'Check the pricing page'] }));
    const list = await screen.findByRole('list', { name: 'Threads to start' });
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Draft the Q3 summary', 'Pull the churn numbers', 'Check the pricing page']);
    expect(api.createTerminal).not.toHaveBeenCalled();
    expect(api.sendStructuredMessage).not.toHaveBeenCalled();
    // The person confirms: three threads, each with its prompt.
    fireEvent.click(screen.getByRole('button', { name: 'Start 3 threads' }));
    await waitFor(() => expect(api.sendStructuredMessage).toHaveBeenCalledTimes(3));
    expect(api.createTerminal).toHaveBeenCalledTimes(3);
    expect((api.createTerminal as unknown as { mock: { calls: [string][] } }).mock.calls.map((c) => c[0])).toEqual(['s1', 's1', 's1']);
    expect((api.sendStructuredMessage as unknown as { mock: { calls: [string, string][] } }).mock.calls.map((c) => c[1])).toEqual(['Draft the Q3 summary', 'Pull the churn numbers', 'Check the pricing page']);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('empty prompts are dropped; none at all opens nothing', async () => {
    render(<PluginDialogs />);
    act(() => buildSdk().actions.openNewThreads({ prompts: ['  ', ''] }));
    expect(usePluginDialogs.getState().newThreads).toBeNull();
    act(() => buildSdk().actions.openNewThreads({ prompts: ['One', ' '] }));
    const list = await screen.findByRole('list', { name: 'Threads to start' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(usePluginDialogs.getState().newThreads?.sessionId).toBe('s2');
    expect(screen.getByRole('button', { name: 'Start 1 thread' })).toBeInTheDocument();
  });
});
