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
