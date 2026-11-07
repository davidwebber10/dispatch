import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { api } from '../api/client';
import { buildSdk } from './sdk';
import { PluginDialogs, usePluginDialogs } from './PluginDialogs';
import { useProjects } from '../stores/projects';

/** d.actions.createSkill: a review sheet that writes the skill only on Create (coach spec section 4.8, plan Task 12d). */
const DRAFT = { name: 'Test and list', description: 'Run the tests and list the files you changed.', body: '# Test and list\n\nAlways run the tests.' };

beforeEach(() => {
  usePluginDialogs.setState({ schedule: null, newThreads: null, skill: null } as never);
  useProjects.setState({ sessions: [{ id: 's1', name: 'Finance', workingDir: '/w/finance' }, { id: 's2', name: 'Ops', workingDir: '/w/ops' }] as never, activeId: 's2' });
  vi.spyOn(api, 'createSkill').mockImplementation(async (d) => ({ skill: { id: d.id } }) as never);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('d.actions.createSkill', () => {
  it('opens the review sheet with the draft; nothing is written until Create; it resolves with the id', async () => {
    render(<PluginDialogs />);
    let result: Promise<{ id: string } | null> | undefined;
    act(() => { result = buildSdk().actions.createSkill(DRAFT); });
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Create a skill')).toBeInTheDocument();
    expect(within(dialog).getByRole('textbox', { name: 'Name' })).toHaveValue('Test and list');
    expect(within(dialog).getByRole('textbox', { name: 'Id' })).toHaveValue('test-and-list');
    expect(within(dialog).getByRole('textbox', { name: 'Description' })).toHaveValue(DRAFT.description);
    expect(within(dialog).getByRole('textbox', { name: 'SKILL.md' })).toHaveValue(DRAFT.body);
    expect(api.createSkill).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Description' }), { target: { value: 'Tests, then the file list.' } });
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Only Ops' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(api.createSkill).toHaveBeenCalledTimes(1));
    expect(api.createSkill).toHaveBeenCalledWith({ id: 'test-and-list', name: 'Test and list', description: 'Tests, then the file list.', body: DRAFT.body, projects: ['s2'] });
    await expect(result).resolves.toEqual({ id: 'test-and-list' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('Cancel writes nothing and resolves with null; all projects is the default scope', async () => {
    render(<PluginDialogs />);
    let result: Promise<{ id: string } | null> | undefined;
    act(() => { result = buildSdk().actions.createSkill({ ...DRAFT, projectId: 's1' }); });
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('radio', { name: 'All projects' })).toHaveAttribute('aria-checked', 'true');
    expect(within(dialog).getByRole('radio', { name: 'Only Finance' })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await expect(result).resolves.toBeNull();
    expect(api.createSkill).not.toHaveBeenCalled();
  });

  it('an error from the daemon (an id that exists) stays in the sheet, and nothing closes', async () => {
    (api.createSkill as unknown as { mockRejectedValueOnce: (e: Error) => void }).mockRejectedValueOnce(new Error('"test-and-list" is already installed'));
    render(<PluginDialogs />);
    act(() => { void buildSdk().actions.createSkill(DRAFT); });
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(await within(dialog).findByText(/already installed/)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
