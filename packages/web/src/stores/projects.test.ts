import { expect, test, vi, beforeEach } from 'vitest';
import { useProjects } from './projects';
import { api } from '../api/client';

beforeEach(() => {
  useProjects.setState({ sessions: [], activeId: null });
  vi.restoreAllMocks();
});

test('load() populates sessions from the API', async () => {
  vi.spyOn(api, 'listSessions').mockResolvedValue([
    { id: 's1', name: 'a' } as any, { id: 's2', name: 'b' } as any,
  ]);
  await useProjects.getState().load();
  expect(useProjects.getState().sessions.map(s => s.id)).toEqual(['s1', 's2']);
});

test('applyEvent session:status updates the matching session', () => {
  useProjects.setState({ sessions: [{ id: 's1', status: 'waiting' } as any], activeId: null });
  useProjects.getState().applyEvent({ type: 'session:status', sessionId: 's1', status: 'working' });
  expect(useProjects.getState().sessions[0].status).toBe('working');
});

test('applyEvent session:status adopts lastActivityAt so recent-sort reorders live', () => {
  useProjects.setState({ sessions: [{ id: 's1', status: 'waiting', lastActivityAt: '2026-07-01T00:00:00Z' } as any], activeId: null });
  useProjects.getState().applyEvent({ type: 'session:status', sessionId: 's1', status: 'working', lastActivityAt: '2026-07-27T05:00:00Z' });
  expect(useProjects.getState().sessions[0].lastActivityAt).toBe('2026-07-27T05:00:00Z');
});

test('applyEvent session:status without a timestamp leaves lastActivityAt untouched', () => {
  // Passive status flips (attach/resize) don't bump activity on the backend, so the event
  // omits lastActivityAt — the store must NOT clobber the existing value with undefined.
  useProjects.setState({ sessions: [{ id: 's1', status: 'waiting', lastActivityAt: '2026-07-01T00:00:00Z' } as any], activeId: null });
  useProjects.getState().applyEvent({ type: 'session:status', sessionId: 's1', status: 'working' });
  expect(useProjects.getState().sessions[0].lastActivityAt).toBe('2026-07-01T00:00:00Z');
});

test('applyEvent session:archived removes the session', () => {
  useProjects.setState({ sessions: [{ id: 's1' } as any, { id: 's2' } as any], activeId: 's1' });
  useProjects.getState().applyEvent({ type: 'session:archived', sessionId: 's1' });
  expect(useProjects.getState().sessions.map(s => s.id)).toEqual(['s2']);
});

// ---- W2-I: optimistic archive and rename ----
import { useHint } from './hint';

test('archive removes the project before the request ends, and picks the next one when it was active', async () => {
  let resolve!: () => void;
  vi.spyOn(api, 'archiveSession').mockReturnValue(new Promise<void>((r) => { resolve = r; }));
  useProjects.setState({ sessions: [{ id: 's1', name: 'a' } as any, { id: 's2', name: 'b' } as any], activeId: 's1' });
  const done = useProjects.getState().archive('s1');
  expect(useProjects.getState().sessions.map((s) => s.id)).toEqual(['s2']);
  expect(useProjects.getState().activeId).toBe('s2');
  resolve();
  await done;
  expect(useProjects.getState().sessions.map((s) => s.id)).toEqual(['s2']);
});

test('a failed project archive puts it back, says so, and still rejects (the caller does not go on)', async () => {
  vi.spyOn(api, 'archiveSession').mockRejectedValue(new Error('500'));
  vi.spyOn(api, 'listSessions').mockResolvedValue([{ id: 's1', name: 'a' } as any, { id: 's2', name: 'b' } as any]);
  useHint.setState({ msg: null });
  useProjects.setState({ sessions: [{ id: 's1', name: 'a' } as any, { id: 's2', name: 'b' } as any], activeId: 's1' });
  await expect(useProjects.getState().archive('s1')).rejects.toThrow('500');
  expect(useProjects.getState().sessions.map((s) => s.id)).toEqual(['s1', 's2']);
  expect(useProjects.getState().activeId).toBe('s1');
  expect(useHint.getState().msg).toBe('The project could not be archived.');
});

test('rename changes the project name before the request ends; a failure puts the old name back', async () => {
  let reject!: (e: unknown) => void;
  vi.spyOn(api, 'updateSession').mockReturnValue(new Promise((_r, rej) => { reject = rej; }) as any);
  vi.spyOn(api, 'listSessions').mockResolvedValue([{ id: 's1', name: 'Old' } as any]);
  useHint.setState({ msg: null });
  useProjects.setState({ sessions: [{ id: 's1', name: 'Old' } as any], activeId: 's1' });
  const done = useProjects.getState().rename('s1', 'New');
  expect(useProjects.getState().sessions[0].name).toBe('New');
  reject(new Error('500'));
  expect(await done).toBe(false);
  expect(useProjects.getState().sessions[0].name).toBe('Old');
  expect(useHint.getState().msg).toBe('The project could not be renamed.');
});
