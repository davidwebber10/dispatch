import { expect, test, vi, beforeEach } from 'vitest';
import { useTabs } from './tabs';
import { api } from '../api/client';

beforeEach(() => {
  useTabs.setState({ byProject: {}, activeTabId: null });
  vi.restoreAllMocks();
});

test('loadTabs stores terminals under the project id', async () => {
  vi.spyOn(api, 'listTerminals').mockResolvedValue([{ id: 't1', sessionId: 's1' } as any]);
  await useTabs.getState().loadTabs('s1');
  expect(useTabs.getState().byProject['s1'].map(t => t.id)).toEqual(['t1']);
});

test('applyEvent terminal:status updates the matching terminal', () => {
  useTabs.setState({ byProject: { s1: [{ id: 't1', status: 'waiting' } as any] }, activeTabId: null });
  useTabs.getState().applyEvent({ type: 'terminal:status', terminalId: 't1', status: 'working' });
  expect(useTabs.getState().byProject['s1'][0].status).toBe('working');
});

// W1-G (2026-11-09): the virtual tab's label follows Settings > Agents > Control Plane > Name.
test('tabLabel of the virtual tab returns the saved coordinator name', async () => {
  const { tabLabel, dispatchTabId } = await import('./tabs');
  const { useSettings } = await import('./settings');
  const before = useSettings.getState().coordinatorName;
  useSettings.setState({ coordinatorName: 'Houston' });
  expect(tabLabel(dispatchTabId('p1'), {})).toBe('Houston');
  useSettings.setState({ coordinatorName: '   ' });
  expect(tabLabel(dispatchTabId('p1'), {})).toBe('Control Plane'); // a blank name falls back
  expect(tabLabel('missing', {})).toBe('tab');
  useSettings.setState({ coordinatorName: before });
});

// W1-F: a status event must touch one project's array only, so a selector on another
// project (and the memoized ProjectCard behind it) sees the same reference.
test('a status event changes only the array of the project that holds the terminal (identity check)', () => {
  const a = [{ id: 'a1', sessionId: 'A', status: 'waiting' } as any, { id: 'a2', sessionId: 'A', status: 'waiting' } as any];
  const b = [{ id: 'b1', sessionId: 'B', status: 'waiting' } as any];
  useTabs.setState({ byProject: { A: a, B: b }, activeTabId: null });
  useTabs.getState().applyEvent({ type: 'terminal:status', terminalId: 'a1', status: 'working' });
  const next = useTabs.getState().byProject;
  expect(next.B).toBe(b);                 // the other project's array keeps its identity
  expect(next.A).not.toBe(a);             // the holder's array is replaced
  expect(next.A[0].status).toBe('working');
  expect(next.A[0]).not.toBe(a[0]);       // the one row is replaced
  expect(next.A[1]).toBe(a[1]);           // its sibling row keeps its identity
});

test('an equal status changes nothing (the state object is the same)', () => {
  useTabs.setState({ byProject: { A: [{ id: 'a1', sessionId: 'A', status: 'working' } as any] }, activeTabId: null });
  const before = useTabs.getState();
  const listener = vi.fn();
  const off = useTabs.subscribe(listener);
  useTabs.getState().applyEvent({ type: 'terminal:status', terminalId: 'a1', status: 'working' });
  useTabs.getState().applyEvent({ type: 'terminal:status', terminalId: 'unknown', status: 'working' });
  off();
  expect(useTabs.getState()).toBe(before);
  expect(listener).not.toHaveBeenCalled();
});

test('terminal:exit sets waiting on the one row and leaves other projects alone', () => {
  const b = [{ id: 'b1', sessionId: 'B', status: 'working' } as any];
  useTabs.setState({ byProject: { A: [{ id: 'a1', sessionId: 'A', status: 'working' } as any], B: b }, activeTabId: null });
  useTabs.getState().applyEvent({ type: 'terminal:exit', terminalId: 'a1' });
  expect(useTabs.getState().byProject.A[0].status).toBe('waiting');
  expect(useTabs.getState().byProject.B).toBe(b);
});

// ---- W2-I: optimistic archive and rename ----
import { useHint } from './hint';
const row = (id: string, label = id, sessionId = 's1') => ({ id, sessionId, label, type: 'claude-code', status: 'waiting', labelSource: 'user', config: {} }) as any;
function deferred<T>() { let resolve!: (v: T) => void; let reject!: (e: unknown) => void; const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; }

test('archive removes the row before the request ends', async () => {
  const d = deferred<void>();
  vi.spyOn(api, 'archiveTerminal').mockReturnValue(d.promise);
  vi.spyOn(api, 'listTerminals').mockResolvedValue([row('t2')]);
  useTabs.setState({ byProject: { s1: [row('t1'), row('t2')] }, openTabIds: [], activeTabId: null });
  const done = useTabs.getState().archive('t1');
  // Synchronously, with the DELETE still open:
  expect(useTabs.getState().byProject.s1.map((t) => t.id)).toEqual(['t2']);
  d.resolve();
  expect(await done).toBe(true);
  expect(useTabs.getState().byProject.s1.map((t) => t.id)).toEqual(['t2']);
});

test('a failed archive puts the row back', async () => {
  const d = deferred<void>();
  vi.spyOn(api, 'archiveTerminal').mockReturnValue(d.promise);
  vi.spyOn(api, 'listTerminals').mockResolvedValue([row('t1'), row('t2')]);
  useHint.setState({ msg: null });
  useTabs.setState({ byProject: { s1: [row('t1'), row('t2')] }, openTabIds: [], activeTabId: null });
  const done = useTabs.getState().archive('t1');
  expect(useTabs.getState().byProject.s1.map((t) => t.id)).toEqual(['t2']);
  d.reject(new Error('offline'));
  expect(await done).toBe(false);
  expect(useTabs.getState().byProject.s1.map((t) => t.id)).toEqual(['t1', 't2']);
  expect(useHint.getState().msg).toBe('The thread could not be archived.');
});

test('archive of the active thread: the neighbour tab is active at once, and a failure brings the tab back', async () => {
  const d = deferred<void>();
  vi.spyOn(api, 'archiveTerminal').mockReturnValue(d.promise);
  vi.spyOn(api, 'listTerminals').mockResolvedValue([row('t1'), row('t2'), row('t3')]);
  useTabs.setState({ byProject: { s1: [row('t1'), row('t2'), row('t3')] }, openTabIds: ['t1', 't2', 't3'], activeTabId: 't2', tabSession: { t1: 's1', t2: 's1', t3: 's1' } });
  const done = useTabs.getState().archive('t2');
  expect(useTabs.getState().openTabIds).toEqual(['t1', 't3']);
  expect(useTabs.getState().activeTabId).toBe('t3'); // the tab that took its place
  d.reject(new Error('500'));
  await done;
  expect(useTabs.getState().openTabIds).toEqual(['t1', 't2', 't3']); // back in its place
  expect(useTabs.getState().activeTabId).toBe('t2');
});

test('archive of the active thread, success: the tab stays closed and the owner keeps the tab they then chose', async () => {
  const d = deferred<void>();
  vi.spyOn(api, 'archiveTerminal').mockReturnValue(d.promise);
  vi.spyOn(api, 'listTerminals').mockResolvedValue([row('t1'), row('t3')]);
  useTabs.setState({ byProject: { s1: [row('t1'), row('t2'), row('t3')] }, openTabIds: ['t1', 't2', 't3'], activeTabId: 't2', tabSession: { t1: 's1', t2: 's1', t3: 's1' } });
  const done = useTabs.getState().archive('t2');
  useTabs.getState().setActiveTab('t1'); // the owner moves on while the request is open
  d.resolve();
  await done;
  expect(useTabs.getState().openTabIds).toEqual(['t1', 't3']);
  expect(useTabs.getState().activeTabId).toBe('t1');
});

test('a failed archive does not take the owner away from the tab they moved to', async () => {
  const d = deferred<void>();
  vi.spyOn(api, 'archiveTerminal').mockReturnValue(d.promise);
  vi.spyOn(api, 'listTerminals').mockResolvedValue([row('t1'), row('t2'), row('t3')]);
  useTabs.setState({ byProject: { s1: [row('t1'), row('t2'), row('t3')] }, openTabIds: ['t1', 't2', 't3'], activeTabId: 't2', tabSession: { t1: 's1', t2: 's1', t3: 's1' } });
  const done = useTabs.getState().archive('t2');
  useTabs.getState().setActiveTab('t1');
  d.reject(new Error('500'));
  await done;
  expect(useTabs.getState().openTabIds).toEqual(['t1', 't2', 't3']);
  expect(useTabs.getState().activeTabId).toBe('t1');
});

// Final review of v4.5.0: the request can fail on the way back (a timeout, a dropped link) after the
// daemon archived the thread. The store asks the daemon what is true before it puts anything back.
test('a failed archive that the daemon did complete does not bring the row or the tab back', async () => {
  const d = deferred<void>();
  vi.spyOn(api, 'archiveTerminal').mockReturnValue(d.promise);
  vi.spyOn(api, 'listTerminals').mockResolvedValue([row('t1'), row('t3')]); // the truth: t2 is archived
  vi.spyOn(console, 'error').mockImplementation(() => {});
  useHint.setState({ msg: null });
  useTabs.setState({ byProject: { s1: [row('t1'), row('t2'), row('t3')] }, openTabIds: ['t1', 't2', 't3'], activeTabId: 't2', tabSession: { t1: 's1', t2: 's1', t3: 's1' } });
  const done = useTabs.getState().archive('t2');
  d.reject(new Error('timeout'));
  expect(await done).toBe(true); // it is archived
  expect(useTabs.getState().byProject.s1.map((t) => t.id)).toEqual(['t1', 't3']);
  expect(useTabs.getState().openTabIds).toEqual(['t1', 't3']);
  expect(useTabs.getState().activeTabId).toBe('t3');
  expect(useTabs.getState().tabSession.t2).toBeUndefined();
  expect(useHint.getState().msg).toBeNull(); // nothing failed for the owner
});

test('a failed archive with the daemon out of reach puts the row and the tab back', async () => {
  const d = deferred<void>();
  vi.spyOn(api, 'archiveTerminal').mockReturnValue(d.promise);
  vi.spyOn(api, 'listTerminals').mockRejectedValue(new Error('offline')); // the truth cannot be read
  vi.spyOn(console, 'error').mockImplementation(() => {});
  useHint.setState({ msg: null });
  useTabs.setState({ byProject: { s1: [row('t1'), row('t2'), row('t3')] }, openTabIds: ['t1', 't2', 't3'], activeTabId: 't2', tabSession: { t1: 's1', t2: 's1', t3: 's1' } });
  const done = useTabs.getState().archive('t2');
  d.reject(new Error('offline'));
  expect(await done).toBe(false);
  expect(useTabs.getState().byProject.s1.map((t) => t.id)).toEqual(['t1', 't2', 't3']);
  expect(useTabs.getState().openTabIds).toEqual(['t1', 't2', 't3']);
  expect(useTabs.getState().activeTabId).toBe('t2');
  expect(useHint.getState().msg).toBe('The thread could not be archived.');
});

test('a list that loads while the archive is open does not bring the row back', async () => {
  const d = deferred<void>();
  vi.spyOn(api, 'archiveTerminal').mockReturnValue(d.promise);
  vi.spyOn(api, 'listTerminals').mockResolvedValue([row('t1'), row('t2')]); // the daemon has not archived it yet
  useTabs.setState({ byProject: { s1: [row('t1'), row('t2')] }, openTabIds: [], activeTabId: null });
  const done = useTabs.getState().archive('t1');
  await useTabs.getState().loadTabs('s1');
  expect(useTabs.getState().byProject.s1.map((t) => t.id)).toEqual(['t2']);
  d.resolve();
  await done;
});

test('rename changes the label before the request ends', async () => {
  const d = deferred<any>();
  vi.spyOn(api, 'updateTerminal').mockReturnValue(d.promise);
  useTabs.setState({ byProject: { s1: [{ ...row('t1', 'Old'), labelSource: 'default' }] }, activeTabId: null });
  const done = useTabs.getState().rename('t1', 'New');
  expect(useTabs.getState().byProject.s1[0].label).toBe('New');
  expect(useTabs.getState().byProject.s1[0].labelSource).toBe('user');
  d.resolve(row('t1', 'New'));
  expect(await done).toBe(true);
  expect(api.updateTerminal).toHaveBeenCalledWith('t1', { label: 'New' });
  expect(useTabs.getState().byProject.s1[0].label).toBe('New');
  expect(useTabs.getState().autoNamed.t1).toBeUndefined(); // the owner's own rename is not animated as an auto-name
});

test('a failed rename puts the old label back and says so', async () => {
  vi.spyOn(api, 'updateTerminal').mockRejectedValue(new Error('500'));
  vi.spyOn(api, 'listTerminals').mockResolvedValue([row('t1', 'Old')]);
  useHint.setState({ msg: null });
  useTabs.setState({ byProject: { s1: [row('t1', 'Old')] }, activeTabId: null });
  expect(await useTabs.getState().rename('t1', 'New')).toBe(false);
  expect(useTabs.getState().byProject.s1[0].label).toBe('Old');
  expect(useHint.getState().msg).toBe('The thread could not be renamed.');
});

test('rename conflict: two renames in flight, the answer of the first one arrives last and does not win', async () => {
  const first = deferred<any>(); const second = deferred<any>();
  vi.spyOn(api, 'updateTerminal').mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  useTabs.setState({ byProject: { s1: [row('t1', 'Old')] }, activeTabId: null });
  const a = useTabs.getState().rename('t1', 'First');
  const b = useTabs.getState().rename('t1', 'Second');
  expect(useTabs.getState().byProject.s1[0].label).toBe('Second');
  second.resolve(row('t1', 'Second'));
  await b;
  first.resolve(row('t1', 'First'));
  await a;
  expect(useTabs.getState().byProject.s1[0].label).toBe('Second');
});

test('rename conflict: the first of two renames fails; the label of the second stays and no list reload puts the old one back', async () => {
  const first = deferred<any>(); const second = deferred<any>();
  vi.spyOn(api, 'updateTerminal').mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const list = vi.spyOn(api, 'listTerminals').mockResolvedValue([row('t1', 'Old')]);
  useHint.setState({ msg: null });
  useTabs.setState({ byProject: { s1: [row('t1', 'Old')] }, activeTabId: null });
  const a = useTabs.getState().rename('t1', 'First');
  const b = useTabs.getState().rename('t1', 'Second');
  first.reject(new Error('500'));
  expect(await a).toBe(false);
  expect(useTabs.getState().byProject.s1[0].label).toBe('Second');
  expect(list).not.toHaveBeenCalled();
  expect(useHint.getState().msg).toBeNull(); // the rename the owner asked for last is still open
  second.resolve(row('t1', 'Second'));
  expect(await b).toBe(true);
});

test('rename conflict: a list from the daemon (an auto-name, another device) that loads while the rename is open keeps the new label', async () => {
  const d = deferred<any>();
  vi.spyOn(api, 'updateTerminal').mockReturnValue(d.promise);
  vi.spyOn(api, 'listTerminals').mockResolvedValue([{ ...row('t1', 'Auto name from the daemon'), labelSource: 'auto' }]);
  useTabs.setState({ byProject: { s1: [{ ...row('t1', 'Old'), labelSource: 'default' }] }, activeTabId: null });
  const done = useTabs.getState().rename('t1', 'Mine');
  await useTabs.getState().loadTabs('s1');
  expect(useTabs.getState().byProject.s1[0].label).toBe('Mine');
  d.resolve(row('t1', 'Mine'));
  await done;
  expect(useTabs.getState().byProject.s1[0].label).toBe('Mine');
});

test('rename to the same label, or to nothing, sends no request', async () => {
  const spy = vi.spyOn(api, 'updateTerminal');
  useTabs.setState({ byProject: { s1: [row('t1', 'Same')] }, activeTabId: null });
  expect(await useTabs.getState().rename('t1', 'Same')).toBe(true);
  expect(await useTabs.getState().rename('t1', '   ')).toBe(false);
  expect(spy).not.toHaveBeenCalled();
});
