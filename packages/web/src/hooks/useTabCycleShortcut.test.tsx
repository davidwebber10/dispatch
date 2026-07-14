import { renderHook } from '@testing-library/react';
import { test, expect, beforeEach } from 'vitest';
import { useTabCycleShortcut } from './useTabCycleShortcut';
import { useTabs } from '../stores/tabs';

const press = (init: KeyboardEventInit) => {
  const ev = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true, ...init });
  window.dispatchEvent(ev);
  return ev;
};

beforeEach(() => {
  useTabs.setState({ openTabIds: ['a', 'b', 'c'], activeTabId: 'a' });
});

test('Ctrl+Tab advances to the next tab and prevents default', () => {
  renderHook(() => useTabCycleShortcut());
  const ev = press({ ctrlKey: true });
  expect(useTabs.getState().activeTabId).toBe('b');
  expect(ev.defaultPrevented).toBe(true);
});

test('Ctrl+Tab wraps from the last tab to the first', () => {
  useTabs.setState({ activeTabId: 'c' });
  renderHook(() => useTabCycleShortcut());
  press({ ctrlKey: true });
  expect(useTabs.getState().activeTabId).toBe('a');
});

test('Ctrl+Shift+Tab goes backward and wraps', () => {
  renderHook(() => useTabCycleShortcut());
  press({ ctrlKey: true, shiftKey: true });
  expect(useTabs.getState().activeTabId).toBe('c');
});

test('plain Tab and meta/alt combos are ignored', () => {
  renderHook(() => useTabCycleShortcut());
  press({});
  press({ ctrlKey: true, metaKey: true });
  press({ ctrlKey: true, altKey: true });
  expect(useTabs.getState().activeTabId).toBe('a');
});

test('single tab: no change, default not prevented', () => {
  useTabs.setState({ openTabIds: ['a'], activeTabId: 'a' });
  renderHook(() => useTabCycleShortcut());
  const ev = press({ ctrlKey: true });
  expect(useTabs.getState().activeTabId).toBe('a');
  expect(ev.defaultPrevented).toBe(false);
});

test('stale activeTabId recovers to the first tab', () => {
  useTabs.setState({ activeTabId: 'gone' });
  renderHook(() => useTabCycleShortcut());
  press({ ctrlKey: true });
  expect(useTabs.getState().activeTabId).toBe('a');
});

test('listener is removed on unmount', () => {
  const { unmount } = renderHook(() => useTabCycleShortcut());
  unmount();
  press({ ctrlKey: true });
  expect(useTabs.getState().activeTabId).toBe('a');
});
