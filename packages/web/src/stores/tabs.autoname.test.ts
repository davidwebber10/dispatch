import { expect, test, vi, beforeEach, afterEach } from 'vitest';
import { useTabs, AUTO_NAME_TTL_MS } from './tabs';
import { api } from '../api/client';

const NOW = new Date('2026-07-19T12:00:00.000Z').getTime();

function term(over: Record<string, unknown>) {
  return { id: 't1', sessionId: 's1', label: 'Claude Code', labelSource: 'default', ...over } as any;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  useTabs.setState({ byProject: {}, tabSession: {}, autoNamed: {} } as any);
  vi.restoreAllMocks();
});
afterEach(() => { vi.useRealTimers(); });

test('records a transition when a default label becomes auto', async () => {
  useTabs.setState({ byProject: { s1: [term({})] } } as any);
  vi.spyOn(api, 'listTerminals').mockResolvedValue([term({ label: 'Fix login bug', labelSource: 'auto' })]);
  await useTabs.getState().loadTabs('s1');
  expect(useTabs.getState().autoNamed['t1']).toEqual({ from: 'Claude Code', to: 'Fix login bug', at: NOW });
});

test('records nothing on first load — no previous list to diff', async () => {
  vi.spyOn(api, 'listTerminals').mockResolvedValue([term({ label: 'Fix login bug', labelSource: 'auto' })]);
  await useTabs.getState().loadTabs('s1');
  expect(useTabs.getState().autoNamed).toEqual({});
});

test('records nothing on an auto -> auto refresh', async () => {
  useTabs.setState({ byProject: { s1: [term({ label: 'Fix login bug', labelSource: 'auto' })] } } as any);
  vi.spyOn(api, 'listTerminals').mockResolvedValue([term({ label: 'Fix login bug', labelSource: 'auto' })]);
  await useTabs.getState().loadTabs('s1');
  expect(useTabs.getState().autoNamed).toEqual({});
});

test('records nothing for a user rename (default -> user)', async () => {
  useTabs.setState({ byProject: { s1: [term({})] } } as any);
  vi.spyOn(api, 'listTerminals').mockResolvedValue([term({ label: 'My thread', labelSource: 'user' })]);
  await useTabs.getState().loadTabs('s1');
  expect(useTabs.getState().autoNamed).toEqual({});
});

test('records nothing when the label did not actually change', async () => {
  useTabs.setState({ byProject: { s1: [term({})] } } as any);
  vi.spyOn(api, 'listTerminals').mockResolvedValue([term({ label: 'Claude Code', labelSource: 'auto' })]);
  await useTabs.getState().loadTabs('s1');
  expect(useTabs.getState().autoNamed).toEqual({});
});

test('treats a missing labelSource as user — old daemons never animate', async () => {
  useTabs.setState({ byProject: { s1: [term({ labelSource: undefined })] } } as any);
  vi.spyOn(api, 'listTerminals').mockResolvedValue([term({ label: 'Fix login bug', labelSource: undefined })]);
  await useTabs.getState().loadTabs('s1');
  expect(useTabs.getState().autoNamed).toEqual({});
});

test('consumeAutoName returns a fresh entry once, then null', () => {
  useTabs.setState({ autoNamed: { t1: { from: 'a', to: 'b', at: NOW } } } as any);
  expect(useTabs.getState().consumeAutoName('t1')).toEqual({ from: 'a', to: 'b' });
  expect(useTabs.getState().consumeAutoName('t1')).toBeNull();
  expect(useTabs.getState().autoNamed['t1']).toBeUndefined();
});

test('consumeAutoName drops a stale entry without animating', () => {
  useTabs.setState({ autoNamed: { t1: { from: 'a', to: 'b', at: NOW - AUTO_NAME_TTL_MS - 1 } } } as any);
  expect(useTabs.getState().consumeAutoName('t1')).toBeNull();
  expect(useTabs.getState().autoNamed['t1']).toBeUndefined();
});

test('consumeAutoName returns null for an unknown id', () => {
  expect(useTabs.getState().consumeAutoName('nope')).toBeNull();
});

test('loadTabs prunes stale entries left behind by collapsed cards', async () => {
  useTabs.setState({
    byProject: { s1: [term({})] },
    autoNamed: { old: { from: 'a', to: 'b', at: NOW - AUTO_NAME_TTL_MS - 1 } },
  } as any);
  vi.spyOn(api, 'listTerminals').mockResolvedValue([term({ label: 'Fix login bug', labelSource: 'auto' })]);
  await useTabs.getState().loadTabs('s1');
  expect(useTabs.getState().autoNamed['old']).toBeUndefined();
  expect(useTabs.getState().autoNamed['t1']).toBeDefined();
});

test('a stale response landing after a fresher one cannot resurrect a consumed rename for replay', async () => {
  useTabs.setState({ byProject: { s1: [term({})] } } as any);

  // Two overlapping loadTabs('s1') calls, resolving out of order: the older request (still
  // showing the default label) is held open and lands LAST; the newer request (already
  // showing the daemon's auto label) resolves FIRST.
  let resolveStale!: (tabs: unknown) => void;
  const stale = new Promise((resolve) => { resolveStale = resolve; });
  const spy = vi.spyOn(api, 'listTerminals');
  spy.mockImplementationOnce(() => stale as any);
  spy.mockImplementationOnce(() => Promise.resolve([term({ label: 'Fix login bug', labelSource: 'auto' })]));

  const staleCall = useTabs.getState().loadTabs('s1');  // older request, still in flight
  const freshCall = useTabs.getState().loadTabs('s1');  // newer, overlapping request

  await freshCall;
  expect(useTabs.getState().autoNamed['t1']).toEqual({ from: 'Claude Code', to: 'Fix login bug', at: NOW });
  // The label animates — consume the entry, same as the mounted label component does.
  expect(useTabs.getState().consumeAutoName('t1')).toEqual({ from: 'Claude Code', to: 'Fix login bug' });
  expect(useTabs.getState().autoNamed['t1']).toBeUndefined();

  resolveStale([term({})]); // the stale, pre-rename response finally lands
  await staleCall;

  // The stale response must not clobber the fresher, already-animated label.
  expect(useTabs.getState().byProject['s1'][0]).toMatchObject({ label: 'Fix login bug', labelSource: 'auto' });

  // A later ordinary refresh must not re-detect a transition that already animated.
  spy.mockResolvedValue([term({ label: 'Fix login bug', labelSource: 'auto' })]);
  await useTabs.getState().loadTabs('s1');
  expect(useTabs.getState().autoNamed['t1']).toBeUndefined();
});
