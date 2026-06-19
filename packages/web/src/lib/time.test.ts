import { expect, test } from 'vitest';
import { timeAgo } from './time';

const now = Date.parse('2026-06-19T12:00:00Z');

test('formats relative "last active" times', () => {
  expect(timeAgo('2026-06-19T11:58:00Z', now)).toBe('2m');
  expect(timeAgo('2026-06-19T09:00:00Z', now)).toBe('3h');
  expect(timeAgo('2026-06-16T12:00:00Z', now)).toBe('3d');
  expect(timeAgo('2026-06-19T11:59:58Z', now)).toBe('now');
});

test('returns empty string for missing/invalid input', () => {
  expect(timeAgo(null, now)).toBe('');
  expect(timeAgo('not-a-date', now)).toBe('');
});
