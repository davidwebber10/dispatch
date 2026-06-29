import { test, expect } from 'vitest';
import { lineDiff } from './diff';

test('marks added, removed, and context lines via LCS', () => {
  const d = lineDiff('a\nb\nc', 'a\nB\nc');
  expect(d).toEqual([
    { type: 'ctx', text: 'a' },
    { type: 'del', text: 'b' },
    { type: 'add', text: 'B' },
    { type: 'ctx', text: 'c' },
  ]);
});

test('pure addition at the end', () => {
  expect(lineDiff('a', 'a\nb')).toEqual([
    { type: 'ctx', text: 'a' },
    { type: 'add', text: 'b' },
  ]);
});

test('pure deletion', () => {
  expect(lineDiff('a\nb', 'a')).toEqual([
    { type: 'ctx', text: 'a' },
    { type: 'del', text: 'b' },
  ]);
});
