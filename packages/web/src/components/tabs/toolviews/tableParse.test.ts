import { test, expect } from 'vitest';
import { parseTable } from './tableParse';

test('parses a JSON array of objects, unioning keys in first-seen order', () => {
  const t = parseTable('[{"id":1,"name":"a"},{"id":2,"name":"b","extra":true}]');
  expect(t).toEqual({
    columns: ['id', 'name', 'extra'],
    rows: [['1', 'a', ''], ['2', 'b', 'true']],
  });
});

test('parses a GitHub-style markdown table', () => {
  const t = parseTable('| id | name |\n| --- | --- |\n| 1 | a |\n| 2 | b |');
  expect(t).toEqual({ columns: ['id', 'name'], rows: [['1', 'a'], ['2', 'b']] });
});

test('parses TSV with a header row', () => {
  const t = parseTable('id\tname\n1\ta\n2\tb');
  expect(t).toEqual({ columns: ['id', 'name'], rows: [['1', 'a'], ['2', 'b']] });
});

test('returns null for non-tabular text', () => {
  expect(parseTable('just some prose output')).toBeNull();
  expect(parseTable('')).toBeNull();
});

test('stringifies nested object cells instead of [object Object]', () => {
  const t = parseTable('[{"a":{"x":1}}]');
  expect(t!.rows[0][0]).toBe('{"x":1}');
});
