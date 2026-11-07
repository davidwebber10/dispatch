import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CommandPalette } from './CommandPalette';
import { usePluginRegistry } from '../plugins/registry';
import { useUI } from '../stores/ui';

beforeEach(() => {
  usePluginRegistry.setState({ views: [], settings: [], threadMenu: [], projectMenu: [], composerActions: [], slots: [], commands: [], promoted: [], manifests: [], status: {}, badges: {} });
  useUI.setState({ view: 'workspace' });
});

describe('the command palette (plugins slice 6)', () => {
  it('⌘K opens it; typing filters; Enter runs a plugin command; Escape closes', () => {
    const run = vi.fn();
    usePluginRegistry.getState().register('p', { commands: [{ id: 'sync', label: 'Sync the rundown', run }, { id: 'other', label: 'Other thing', run: () => {} }] });
    render(<CommandPalette />);
    expect(screen.queryByRole('dialog', { name: 'Commands' })).toBeNull();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    const dialog = screen.getByRole('dialog', { name: 'Commands' });
    expect(dialog).toHaveTextContent('Analytics');
    expect(dialog).toHaveTextContent('Sync the rundown');
    fireEvent.change(screen.getByRole('combobox', { name: 'Command' }), { target: { value: 'rund' } });
    expect(screen.getAllByRole('option').map((o) => o.getAttribute('aria-label'))).toEqual(['Sync the rundown']);
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Command' }), { key: 'Enter' });
    expect(run).toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'Commands' })).toBeNull();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Command' }), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Commands' })).toBeNull();
  });

  it('a built-in row opens a view', () => {
    render(<CommandPalette />);
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    fireEvent.click(screen.getByRole('option', { name: 'Analytics' }));
    expect(useUI.getState().view).toBe('analytics');
  });
});
