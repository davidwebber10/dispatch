import { render, screen, fireEvent, within } from '@testing-library/react';
import { vi, beforeEach, afterEach, describe, it, expect } from 'vitest';
import { MobileApp } from './MobileApp';
import { useTabs } from '../../stores/tabs';
import { api } from '../../api/client';
import { usePluginRegistry } from '../../plugins/registry';

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true, writable: true });
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: window.innerWidth <= 768, media: query, addEventListener: () => {}, removeEventListener: () => {} }));
  useTabs.setState({ byProject: {}, openTabIds: [], activeTabId: null, tabSession: {} });
  vi.spyOn(api, 'listSessions').mockResolvedValue([] as any);
  vi.spyOn(api, 'listTerminals').mockResolvedValue([] as any);
  usePluginRegistry.setState({ views: [], settings: [], threadMenu: [], projectMenu: [], composerActions: [], slots: [], promoted: [], manifests: [], status: {} });
  localStorage.clear();
  window.history.pushState({}, '', '/');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const tabLabels = () => within(screen.getByTestId('bottom-tabs')).getAllByRole('button').map((b) => b.textContent);

describe('MobileApp plugin screens (2026-11-07)', () => {
  it('with no plugin views the tab bar has four tabs', () => {
    render(<MobileApp />);
    expect(tabLabels()).toEqual(['Projects', 'Chat', 'Analytics', 'Settings']);
  });

  it('with a plugin view the Plugins tab appears and lists it; tapping opens the view', () => {
    usePluginRegistry.getState().register('daily-rundown', { views: [{ id: 'rundown', label: 'Rundown', icon: 'sun', Component: () => <div>rundown screen</div> }] });
    render(<MobileApp />);
    expect(tabLabels()).toEqual(['Projects', 'Chat', 'Analytics', 'Plugins', 'Settings']);
    fireEvent.click(screen.getByRole('button', { name: 'Plugins' }));
    const row = screen.getByRole('button', { name: /Rundown/ });
    expect(row).toHaveTextContent('daily-rundown');
    fireEvent.click(row);
    expect(screen.getByText('rundown screen')).toBeInTheDocument();
  });

  it('the Plugins tab says where to find plugins when none has a screen but a plugin exists', () => {
    usePluginRegistry.getState().register('only-settings', { settings: [{ id: 's', label: 'S', Component: () => null }] });
    usePluginRegistry.setState({ manifests: [{ id: 'only-settings', name: 'Only settings', version: '1', enabled: true, stamp: 1, install: null }] });
    render(<MobileApp />);
    expect(tabLabels()).toEqual(['Projects', 'Chat', 'Analytics', 'Plugins', 'Settings']);
    fireEvent.click(screen.getByRole('button', { name: 'Plugins' }));
    expect(screen.getByText(/No plugin screens yet/)).toBeInTheDocument();
  });

  it('a promoted view gets its own tab before Plugins; at most two', () => {
    const reg = usePluginRegistry.getState().register;
    reg('a', { views: [{ id: 'v', label: 'Alpha', Component: () => <div>alpha screen</div> }] });
    reg('b', { views: [{ id: 'v', label: 'Beta', Component: () => null }] });
    reg('c', { views: [{ id: 'v', label: 'Gamma', Component: () => null }] });
    usePluginRegistry.getState().setPromoted(['plugin:a:v', 'plugin:b:v', 'plugin:c:v']);
    render(<MobileApp />);
    expect(tabLabels()).toEqual(['Projects', 'Chat', 'Analytics', 'Alpha', 'Beta', 'Plugins', 'Settings']);
    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }));
    expect(screen.getByText('alpha screen')).toBeInTheDocument();
  });
});
