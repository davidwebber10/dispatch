import { it, expect } from 'vitest';
import { useUI, loadView } from './ui';
import { useNavigation } from './navigation';

// W2-F (2026-11-09): the pending fields are gone; a request is a `navigate` (stores/navigation.test.ts has the rest).
it('requestOpenProject navigates to the project and keeps no pending field', () => {
  useUI.getState().requestOpenProject('s1');
  expect(useNavigation.getState().route).toEqual({ view: 'workspace', projectId: 's1' });
  expect('pendingOpenProject' in useUI.getState()).toBe(false);
  expect('clearOpenProject' in useUI.getState()).toBe(false);
  window.history.pushState({}, '', '/');
});

it('a saved plugin view key is accepted by loadView; an unknown key falls back (2026-11-07)', () => {
  localStorage.setItem('dispatch:view', 'plugin:daily-rundown:rundown');
  expect(loadView()).toBe('plugin:daily-rundown:rundown');
  localStorage.setItem('dispatch:view', 'nonsense');
  expect(loadView()).toBe('workspace');
  localStorage.removeItem('dispatch:view');
});

it('a saved board view loads as workspace', () => {
  // The board view was removed (W1-G, 2026-11-09). A browser that saved it must still open.
  localStorage.setItem('dispatch:view', 'board');
  expect(loadView()).toBe('workspace');
  localStorage.removeItem('dispatch:view');
});
