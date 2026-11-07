import { it, expect } from 'vitest';
import { useUI, loadView } from './ui';

it('requestOpenProject sets and clears the intent', () => {
  useUI.getState().requestOpenProject('s1');
  expect(useUI.getState().pendingOpenProject).toBe('s1');
  useUI.getState().clearOpenProject();
  expect(useUI.getState().pendingOpenProject).toBeNull();
});

it('a saved plugin view key is accepted by loadView; an unknown key falls back (2026-11-07)', () => {
  localStorage.setItem('dispatch:view', 'plugin:daily-rundown:rundown');
  expect(loadView()).toBe('plugin:daily-rundown:rundown');
  localStorage.setItem('dispatch:view', 'nonsense');
  expect(loadView()).toBe('workspace');
  localStorage.removeItem('dispatch:view');
});
