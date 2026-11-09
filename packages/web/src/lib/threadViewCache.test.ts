import { beforeEach, expect, test } from 'vitest';
import { threadViewCache, MAX_THREADS, MAX_ITEMS } from './threadViewCache';
import type { ConvItem } from '../api/types';

const items = (n: number, tag = ''): ConvItem[] => Array.from({ length: n }, (_, i) => ({ kind: 'assistant', text: `${tag}${i}`, uuid: `${tag}u${i}` }));

beforeEach(() => threadViewCache.clear());

test('get returns what put stored, and the same array each time', () => {
  threadViewCache.put('t1', items(3));
  expect(threadViewCache.get('t1')?.map((i) => i.text)).toEqual(['0', '1', '2']);
  expect(threadViewCache.get('t1')).toBe(threadViewCache.get('t1'));
  expect(threadViewCache.get('missing')).toBeUndefined();
});

test('the 21st thread removes the oldest', () => {
  expect(MAX_THREADS).toBe(20);
  for (let i = 1; i <= 20; i++) threadViewCache.put(`t${i}`, items(1));
  expect(threadViewCache.get('t1')).toBeDefined(); // a read makes t1 the newest; t2 is now the oldest
  threadViewCache.put('t21', items(1));
  expect(threadViewCache.get('t2')).toBeUndefined();
  expect(threadViewCache.get('t1')).toBeDefined();
  expect(threadViewCache.get('t21')).toBeDefined();
  expect(threadViewCache.size()).toBe(20);
});

test('a thread keeps its newest 300 items', () => {
  expect(MAX_ITEMS).toBe(300);
  threadViewCache.put('t1', items(450));
  const got = threadViewCache.get('t1')!;
  expect(got).toHaveLength(300);
  expect(got[0].text).toBe('150');
  expect(got[299].text).toBe('449');
});

test('an unsent local bubble is not stored, and an empty list removes the entry', () => {
  threadViewCache.put('t1', [...items(2), { kind: 'user', text: 'not yet sent', localId: 'local-1', sendState: 'sending' }]);
  expect(threadViewCache.get('t1')).toHaveLength(2);
  threadViewCache.put('t1', []);
  expect(threadViewCache.get('t1')).toBeUndefined();
});

test('the stored list is a copy: a later change of the source does not reach it', () => {
  const src = items(2);
  threadViewCache.put('t1', src);
  src.push({ kind: 'assistant', text: 'later' });
  expect(threadViewCache.get('t1')).toHaveLength(2);
  threadViewCache.remove('t1');
  expect(threadViewCache.get('t1')).toBeUndefined();
});
