import { expect, test } from 'vitest';
import { projectIndicator } from './status';

test('needs_input on any thread wins (most actionable)', () => {
  expect(projectIndicator('working', ['working', 'needs_input'], false)).toBe('needs_input');
  expect(projectIndicator('needs_input', [], false)).toBe('needs_input');
});

test('working (or a loading tab) outranks error and idle', () => {
  expect(projectIndicator('waiting', ['working'], false)).toBe('working');
  expect(projectIndicator('waiting', [], true)).toBe('working'); // a tab is spinning up
  expect(projectIndicator('waiting', ['error'], false)).toBe('error');
});

test('error outranks idle only', () => {
  expect(projectIndicator('error', [], false)).toBe('error');
  expect(projectIndicator('waiting', ['waiting', 'error'], false)).toBe('error');
});

test('idle when nothing notable', () => {
  expect(projectIndicator('waiting', ['waiting'], false)).toBe('idle');
  expect(projectIndicator(undefined, [], false)).toBe('idle');
});
