import { it, expect } from 'vitest';
import { useUI } from './ui';

it('requestOpenProject sets and clears the intent', () => {
  useUI.getState().requestOpenProject('s1');
  expect(useUI.getState().pendingOpenProject).toBe('s1');
  useUI.getState().clearOpenProject();
  expect(useUI.getState().pendingOpenProject).toBeNull();
});
