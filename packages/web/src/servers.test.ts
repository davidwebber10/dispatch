import { expect, test } from 'vitest';
import { currentServer, currentLabel, SERVERS } from './servers';

test('currentServer matches a known origin', () => {
  expect(currentServer('http://davids-blackbook-pro.tailb919ab.ts.net:3456')?.label).toBe('MacBook');
  expect(currentServer('http://davids-mac-mini.tailb919ab.ts.net:3456')?.label).toBe('Mac mini');
});

test('currentLabel falls back to Local for unknown origins', () => {
  expect(currentLabel('http://localhost:5173')).toBe('Local');
});

test('every server has a parseable origin', () => {
  for (const s of SERVERS) expect(() => new URL(s.origin)).not.toThrow();
});
