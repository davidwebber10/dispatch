import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { usePluginRegistry } from '../../plugins/registry';
import { settingsSection } from './sections';

/**
 * A plugin registers again to change its other contributions (Composer favorites does after each
 * edit). The Settings screen that is open must stay mounted: its state and the focused field stay.
 */
const KEY = 'plugin:demo:main';
function Counter() {
  const [n, setN] = useState(0);
  return <button onClick={() => setN(n + 1)}>count {n}</button>;
}
const register = () => usePluginRegistry.getState().register('demo', { settings: [{ id: 'main', label: 'Demo', Component: Counter }] });
function Host() {
  usePluginRegistry((s) => s.settings);
  const Body = settingsSection(KEY)!.Component;
  return <Body />;
}

beforeEach(() => { usePluginRegistry.getState().unregister('demo'); });
afterEach(() => { cleanup(); usePluginRegistry.getState().unregister('demo'); });

describe('a plugin settings section', () => {
  it('keeps its screen mounted when the plugin registers again with the same component', () => {
    register();
    render(<Host />);
    fireEvent.click(screen.getByText('count 0'));
    expect(screen.getByText('count 1')).toBeTruthy();
    const before = settingsSection(KEY)!.Component;
    act(() => { register(); });
    expect(settingsSection(KEY)!.Component).toBe(before);
    expect(screen.getByText('count 1')).toBeTruthy();
  });
});
