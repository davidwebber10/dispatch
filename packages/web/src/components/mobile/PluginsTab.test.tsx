import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { PluginsTab } from './PluginsTab';
import { usePluginRegistry } from '../../plugins/registry';

beforeEach(() => {
  usePluginRegistry.setState({ views: [], settings: [], threadMenu: [], projectMenu: [], composerActions: [], slots: [], promoted: [], manifests: [], status: {}, badges: {} });
});

describe('PluginsTab (2026-11-07)', () => {
  it('a plugin with something new shows its count on its own row, so the tab dot is never a mystery', () => {
    usePluginRegistry.getState().register('previews', { views: [{ id: 'history', label: 'Previews', icon: 'eye', Component: () => null }] });
    usePluginRegistry.getState().register('coach', { views: [{ id: 'coach', label: 'Coach', icon: 'sparkle', Component: () => null }] });
    const [pv, coach] = usePluginRegistry.getState().views;
    act(() => { usePluginRegistry.setState((s) => ({ badges: { ...s.badges, [pv.key]: 23 } })); });
    render(<PluginsTab onOpen={() => {}} />);
    expect(screen.getByRole('button', { name: /Previews/ })).toHaveTextContent('23');
    expect(screen.getByLabelText('23 new')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Coach/ }).textContent).not.toMatch(/\d/);
    act(() => { usePluginRegistry.setState((s) => ({ badges: { ...s.badges, [pv.key]: 0, [coach.key]: 1 } })); });
    expect(screen.queryByLabelText('23 new')).toBeNull();
    expect(screen.getByLabelText('1 new')).toBeInTheDocument();
  });
});
