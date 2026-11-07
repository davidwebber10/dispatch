import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IconRail } from './IconRail';
import { PROJECTS_ICON, THREADS_ICON } from '../common/viewIcons';
import { Folders, TerminalWindow } from '@phosphor-icons/react';
import { useUI } from '../../stores/ui';
import { usePluginRegistry } from '../../plugins/registry';
import { useProjectsView } from '../../stores/projectsView';

beforeEach(() => {
  useUI.setState({ view: 'workspace' });
  useProjectsView.setState({ view: 'projects' });
  usePluginRegistry.setState({ views: [], settings: [], threadMenu: [], projectMenu: [], composerActions: [], slots: [], promoted: [], manifests: [], status: {}, badges: {} });
});

describe('IconRail plugin views (2026-11-07)', () => {
  it('a registered plugin view is a rail item after Analytics; clicking sets the view to its key', () => {
    usePluginRegistry.getState().register('daily-rundown', { views: [{ id: 'rundown', label: 'Rundown', icon: 'sun', Component: () => null }] });
    render(<IconRail />);
    const items = screen.getAllByRole('button').map((b) => b.getAttribute('title'));
    expect(items.indexOf('Rundown')).toBeGreaterThan(items.indexOf('Analytics'));
    expect(items.indexOf('Rundown')).toBeLessThan(items.indexOf('Settings (⌘,)'));
    fireEvent.click(screen.getByTitle('Rundown'));
    expect(useUI.getState().view).toBe('plugin:daily-rundown:rundown');
    expect(screen.getByTitle('Rundown')).toHaveAttribute('aria-pressed', 'true');
  });

  it('with no plugin views the rail is unchanged', () => {
    render(<IconRail />);
    expect(screen.getAllByRole('button').map((b) => b.getAttribute('title'))).toEqual(expect.arrayContaining(['Projects', 'Chat', 'Analytics', 'Settings (⌘,)']));
    expect(screen.queryByTitle('Rundown')).toBeNull();
  });

  it('a plugin item shows its badge count', () => {
    usePluginRegistry.getState().register('previews', { views: [{ id: 'history', label: 'Previews+', icon: 'eye', Component: () => null }] });
    usePluginRegistry.getState().setBadge('plugin:previews:history', 2);
    render(<IconRail />);
    expect(screen.getByLabelText('2 new').closest('button')).toHaveAttribute('title', 'Previews+');
  });

  it('the first rail item reads Projects or Threads, following the switch', () => {
    useProjectsView.setState({ view: 'projects' });
    const { rerender } = render(<IconRail />);
    expect(screen.getByTitle('Projects')).toBeInTheDocument();
    act(() => { useProjectsView.getState().setView('threads'); });
    rerender(<IconRail />);
    expect(screen.getByTitle('Threads')).toBeInTheDocument();
    expect(screen.queryByTitle('Projects')).toBeNull();
  });

  it('Projects and Threads draw the same icons as the phone tab bar (Folders, TerminalWindow)', () => {
    expect(PROJECTS_ICON).toBe(Folders);
    expect(THREADS_ICON).toBe(TerminalWindow);
    // The rail fills the active item and outlines the rest; either weight of the same icon matches.
    const drawn = (C: typeof Folders) => (['regular', 'fill'] as const).map((w) => render(<C size={18} weight={w} />).container.querySelector('svg')!.innerHTML);
    for (const [view, title, icon] of [['projects', 'Projects', Folders], ['threads', 'Threads', TerminalWindow]] as const) {
      act(() => { useProjectsView.getState().setView(view); });
      const { unmount } = render(<IconRail />);
      expect(drawn(icon)).toContain(screen.getByTitle(title).querySelector('svg')!.innerHTML);
      unmount();
    }
  });
});
