import { expect, test, beforeEach } from 'vitest';
import { useListSort, LIST_SORT_KEY } from './listSort';

beforeEach(() => {
  localStorage.clear();
  useListSort.setState({ threads: {}, agents: {} });
});

test('unset projects get the documented defaults', () => {
  expect(useListSort.getState().threadSort('p1')).toBe('custom');
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
  expect(useListSort.getState().threadSort('p2')).toBe('custom');
});

test('the two tabs are independent', () => {
  useListSort.getState().setThreadSort('p1', 'oldest');
  expect(useListSort.getState().agentSort('p1')).toBe('next');
});

test('choices persist to localStorage under the documented key', () => {
  useListSort.getState().setThreadSort('p1', 'active');
  useListSort.getState().setAgentSort('p1', 'name');
  const raw = JSON.parse(localStorage.getItem(LIST_SORT_KEY) || '{}');
  expect(raw).toEqual({ threads: { p1: 'active' }, agents: { p1: 'name' } });
});

test('an unknown persisted value falls back to the default instead of being trusted', () => {
  useListSort.setState({ threads: { p1: 'bogus' as any }, agents: { p1: 'bogus' as any } });
  expect(useListSort.getState().threadSort('p1')).toBe('custom');
  expect(useListSort.getState().agentSort('p1')).toBe('next');
});
