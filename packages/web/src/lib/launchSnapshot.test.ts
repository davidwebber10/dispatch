import { beforeEach, expect, test } from 'vitest';
import { readSnapshot, resetSnapshotCache, writeSnapshot } from './launchSnapshot';
import type { Session, Terminal } from '../api/types';

beforeEach(() => { localStorage.clear(); resetSnapshotCache(); });

const session = { id: 'p1', name: 'Dispatch' } as Session;
const thread = { id: 't1', sessionId: 'p1', label: 'Fix launch' } as Terminal;

test('round-trips the project and thread lists', () => {
  writeSnapshot({ sessions: [session], byProject: { p1: [thread] } });
  resetSnapshotCache();
  expect(readSnapshot()).toEqual({ sessions: [session], byProject: { p1: [thread] } });
});

test('an empty project list never overwrites a good snapshot (a failed load)', () => {
  writeSnapshot({ sessions: [session], byProject: {} });
  writeSnapshot({ sessions: [], byProject: {} });
  resetSnapshotCache();
  expect(readSnapshot()?.sessions).toEqual([session]);
});

test('no snapshot, or a corrupt one, reads as null', () => {
  expect(readSnapshot()).toBeNull();
  localStorage.setItem('dispatch:launch-snapshot:v1', '{not json');
  resetSnapshotCache();
  expect(readSnapshot()).toBeNull();
});

test('skips a snapshot too big to be worth keeping', () => {
  const many = Array.from({ length: 3000 }, (_, i) => ({ ...thread, id: `t${i}`, label: 'x'.repeat(200) }));
  writeSnapshot({ sessions: [session], byProject: { p1: many } });
  resetSnapshotCache();
  expect(readSnapshot()).toBeNull();
});
