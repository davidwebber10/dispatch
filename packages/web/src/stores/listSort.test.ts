import { expect, test, beforeEach, vi } from 'vitest';
import { useListSort, LIST_SORT_KEY } from './listSort';

beforeEach(() => {
  localStorage.clear();
  useListSort.setState({ threads: {}, agents: {} });
});

test('unset projects get the documented defaults', () => {
  expect(useListSort.getState().threadSort('p1')).toBe('active');
  expect(useListSort.getState().agentSort('p1')).toBe('next');
});

test('set then read round-trips per tab', () => {
  useListSort.getState().setThreadSort('p1', 'name');
  useListSort.getState().setAgentSort('p1', 'updated');
  expect(useListSort.getState().threadSort('p1')).toBe('name');
  expect(useListSort.getState().agentSort('p1')).toBe('updated');
});

test('projects are independent', () => {
  useListSort.getState().setThreadSort('p1', 'newest');
  expect(useListSort.getState().threadSort('p2')).toBe('active');
});

test('the two tabs are independent', () => {
  useListSort.getState().setThreadSort('p1', 'oldest');
  expect(useListSort.getState().agentSort('p1')).toBe('next');
});

test('choices persist to localStorage under the documented key', () => {
  useListSort.getState().setThreadSort('p1', 'active');
  useListSort.getState().setAgentSort('p1', 'name');
  const raw = JSON.parse(localStorage.getItem(LIST_SORT_KEY) || '{}');
  expect(raw).toEqual({ threads: { p1: 'active' }, agents: { p1: 'name' }, v: 2 });
});

test('an unknown persisted value falls back to the default instead of being trusted', () => {
  useListSort.setState({ threads: { p1: 'bogus' as any }, agents: { p1: 'bogus' as any } });
  expect(useListSort.getState().threadSort('p1')).toBe('active');
  expect(useListSort.getState().agentSort('p1')).toBe('next');
});

test('once, a saved "custom" thread sort (the old default) falls to Recently active; other choices stay', async () => {
  localStorage.setItem(LIST_SORT_KEY, JSON.stringify({ threads: { p1: 'custom', p2: 'name' }, agents: { p1: 'updated' } }));
  vi.resetModules();
  const fresh = await import('./listSort');
  expect(fresh.useListSort.getState().threadSort('p1')).toBe('active');
  expect(fresh.useListSort.getState().threadSort('p2')).toBe('name');
  expect(fresh.useListSort.getState().agentSort('p1')).toBe('updated');
  // Migrated once: a project switched to custom afterwards (a drag) keeps it across reloads.
  fresh.useListSort.getState().setThreadSort('p1', 'custom');
  vi.resetModules();
  const again = await import('./listSort');
  expect(again.useListSort.getState().threadSort('p1')).toBe('custom');
});
