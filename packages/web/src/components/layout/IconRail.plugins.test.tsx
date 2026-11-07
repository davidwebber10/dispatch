import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IconRail } from './IconRail';
import { useUI } from '../../stores/ui';
import { usePluginRegistry } from '../../plugins/registry';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ previews: [], unseen: 0 }) }));
  useUI.setState({ view: 'workspace' });
  usePluginRegistry.setState({ views: [], settings: [], threadMenu: [], projectMenu: [], composerActions: [], slots: [], promoted: [], manifests: [], status: {}, badges: {} });
});

describe('IconRail plugin views (2026-11-07)', () => {
  it('a registered plugin view is a rail item after Previews; clicking sets the view to its key', () => {
    usePluginRegistry.getState().register('daily-rundown', { views: [{ id: 'rundown', label: 'Rundown', icon: 'sun', Component: () => null }] });
    render(<IconRail />);
    const items = screen.getAllByRole('button').map((b) => b.getAttribute('title'));
    expect(items.indexOf('Rundown')).toBeGreaterThan(items.indexOf('Previews'));
    expect(items.indexOf('Rundown')).toBeLessThan(items.indexOf('Settings (⌘,)'));
    fireEvent.click(screen.getByTitle('Rundown'));
    expect(useUI.getState().view).toBe('plugin:daily-rundown:rundown');
    expect(screen.getByTitle('Rundown')).toHaveAttribute('aria-pressed', 'true');
  });

  it('with no plugin views the rail is unchanged', () => {
    render(<IconRail />);
    expect(screen.getAllByRole('button').map((b) => b.getAttribute('title'))).toEqual(expect.arrayContaining(['Threads', 'Chat', 'Analytics', 'Previews', 'Settings (⌘,)']));
    expect(screen.queryByTitle('Rundown')).toBeNull();
  });

  it('a plugin item shows its badge count', () => {
    usePluginRegistry.getState().register('previews', { views: [{ id: 'history', label: 'Previews+', icon: 'eye', Component: () => null }] });
    usePluginRegistry.getState().setBadge('plugin:previews:history', 2);
    render(<IconRail />);
    expect(screen.getByLabelText('2 new').closest('button')).toHaveAttribute('title', 'Previews+');
  });
});
