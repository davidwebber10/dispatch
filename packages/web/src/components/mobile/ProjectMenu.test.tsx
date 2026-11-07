import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ProjectMenu } from './ProjectMenu';
import { usePluginRegistry } from '../../plugins/registry';
import type { Session } from '../../api/types';

const project = { id: 's1', name: 'Alpha', workingDir: '/tmp/alpha', provider: 'claude-code', status: 'idle', lastActivityAt: '2026-11-07T00:00:00Z' } as unknown as Session;

beforeEach(() => {
  usePluginRegistry.setState({ views: [], settings: [], threadMenu: [], projectMenu: [], composerActions: [], slots: [], promoted: [], manifests: [], status: {} });
});

describe('ProjectMenu plugin items (2026-11-07)', () => {
  it('a plugin item shows first with the session, and closes the menu when picked', () => {
    const onPick = vi.fn();
    usePluginRegistry.getState().register('p', { projectMenu: [{ id: 'open-code', label: 'Open in VS Code', onPick }] });
    const onClose = vi.fn();
    render(<ProjectMenu project={project} open onClose={onClose} onArchived={() => {}} />);
    const menu = screen.getByRole('menu');
    const labels = within(menu).getAllByRole('button').map((b) => b.textContent);
    expect(labels.indexOf('Open in VS Code')).toBe(0);
    fireEvent.click(within(menu).getByRole('button', { name: 'Open in VS Code' }));
    expect(onPick).toHaveBeenCalledWith({ session: expect.objectContaining({ id: 's1' }) });
    expect(onClose).toHaveBeenCalled();
  });

  it('`when` hides an item for a project it does not apply to', () => {
    usePluginRegistry.getState().register('p', { projectMenu: [{ id: 'x', label: 'Only beta', when: ({ session }) => session.name === 'Beta', onPick: () => {} }] });
    render(<ProjectMenu project={project} open onClose={() => {}} onArchived={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Only beta' })).toBeNull();
  });
});
