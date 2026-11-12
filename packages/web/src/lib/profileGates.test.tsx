import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { setHostContextForTest } from './hostContext';
import { visibleSettingsSections, settingsGroupLabel, settingsSection } from '../components/settings/sections';
import { accountDisplayLabel, STOCK_CLI_ACCOUNT_LABEL } from './hostCopy';
import { NewProjectModal } from '../components/sidebar/NewProjectModal';
import { api } from '../api/client';

afterEach(() => { setHostContextForTest({}); vi.restoreAllMocks(); });

describe('settings follow the profile', () => {
  it('a local developer sees every section, under THIS MAC', () => {
    expect(visibleSettingsSections().map((s) => s.key)).toEqual([
      'appearance', 'notifications', 'dictation', 'agents', 'accounts', 'usage', 'integrations', 'secrets', 'tools',
      'devices', 'servers', 'plugins', 'skills', 'about',
    ]);
    expect(settingsGroupLabel('THIS MAC')).toBe('THIS MAC');
  });

  it('a hosted developer loses only what cannot work on a hosted workspace', () => {
    setHostContextForTest({ hosted: true, profile: 'developer' });
    const keys = visibleSettingsSections().map((s) => s.key);
    expect(keys).not.toContain('devices');
    expect(keys).not.toContain('servers');
    expect(keys).toContain('secrets');
    expect(settingsGroupLabel('THIS MAC')).toBe('THIS WORKSPACE');
  });

  it('a business person sees the short list; a link to a hidden section falls back', () => {
    setHostContextForTest({ hosted: true, profile: 'business' });
    expect(visibleSettingsSections().map((s) => s.key)).toEqual(['appearance', 'notifications', 'accounts', 'about']);
    expect(settingsSection('secrets')).toBeUndefined();
    expect(settingsSection('appearance')?.key).toBe('appearance');
  });
});

describe('account names', () => {
  it('the stock CLI login name is plain on a hosted workspace only', () => {
    expect(accountDisplayLabel('claude', STOCK_CLI_ACCOUNT_LABEL, true)).toBe(STOCK_CLI_ACCOUNT_LABEL);
    setHostContextForTest({ hosted: true });
    expect(accountDisplayLabel('claude', STOCK_CLI_ACCOUNT_LABEL, true)).toBe('Your Claude account');
    expect(accountDisplayLabel('codex', STOCK_CLI_ACCOUNT_LABEL, true)).toBe('Your Codex account');
    expect(accountDisplayLabel('claude', 'Work', true)).toBe('Work');
  });
});

describe('New Project', () => {
  it('a hosted business person gives a name only, and a refusal is shown', async () => {
    setHostContextForTest({ hosted: true, profile: 'business' });
    const create = vi.spyOn(api, 'createSession').mockRejectedValue(new Error('workingDir is required'));
    render(<NewProjectModal open onClose={() => {}} />);
    expect(screen.queryByPlaceholderText('/path/to/project')).toBeNull();
    fireEvent.click(screen.getByText('Create Project'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Type a name');
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Q4 plan' } });
    fireEvent.click(screen.getByText('Create Project'));
    expect(await screen.findByText(/Could not create the project: workingDir is required/)).toBeTruthy();
    expect(create).toHaveBeenCalledWith({ provider: 'claude-code', name: 'Q4 plan' });
  });

  it('a hosted developer keeps the folder under Advanced', () => {
    setHostContextForTest({ hosted: true, profile: 'developer' });
    render(<NewProjectModal open onClose={() => {}} />);
    expect(screen.queryByPlaceholderText('/path/to/project')).toBeNull();
    fireEvent.click(screen.getByText(/Advanced/));
    expect(screen.getByPlaceholderText('/path/to/project')).toBeTruthy();
  });

  it('a local developer sees the folder at once (unchanged)', () => {
    render(<NewProjectModal open onClose={() => {}} />);
    expect(screen.getByPlaceholderText('/path/to/project')).toBeTruthy();
  });
});
