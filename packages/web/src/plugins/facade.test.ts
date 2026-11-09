import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { createPluginSdk, SDK_V2_KEYS } from './facade';
import { applyPluginEvent } from './host';
import { usePluginRegistry } from './registry';
import { useTabs } from '../stores/tabs';
import { useProjects } from '../stores/projects';
import { useThreadStatus } from '../stores/threadStatus';
import { useNavigation } from '../stores/navigation';
import { useHint } from '../stores/hint';

/**
 * The narrow plugin SDK (engineering program 2026-11-09, W3-F). `createPluginSdk(id)` binds the
 * plugin id: no function of the object takes an id from the caller, so a plugin cannot name another
 * plugin's storage, settings, worker, files or model budget.
 */
interface Call { method: string; url: string; headers: Headers; body: unknown }

function fakeDaemon() {
  const docs = new Map<string, unknown>();
  const settings = new Map<string, unknown>();
  const calls: Call[] = [];
  const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body), headers: new Headers({ 'content-type': 'application/json' }) });
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input); const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
    calls.push({ method, url, headers: new Headers(init?.headers), body });
    let m = /\/api\/plugins\/([^/]+)\/data\/([^/?]+)$/.exec(url);
    if (m) {
      const k = `${m[1]}/${decodeURIComponent(m[2])}`;
      if (method === 'GET') return docs.has(k) ? json(200, { key: m[2], value: docs.get(k) }) : json(404, { error: 'document not found' });
      if (method === 'PUT') { docs.set(k, (body as { value: unknown }).value); return json(200, { key: m[2], value: docs.get(k) }); }
      if (method === 'DELETE') { const had = docs.delete(k); return had ? { ok: true, status: 204, json: async () => null, text: async () => '', headers: new Headers() } : json(404, { error: 'document not found' }); }
    }
    m = /\/api\/plugins\/([^/]+)\/data(\?values=1)?$/.exec(url);
    if (m) return json(200, { docs: [...docs.keys()].filter((k) => k.startsWith(`${m![1]}/`)).map((k) => ({ key: k.slice(m![1].length + 1), ...(m![2] ? { value: docs.get(k) } : {}) })) });
    m = /\/api\/plugins\/([^/]+)\/settings$/.exec(url);
    if (m) {
      if (method === 'GET') return json(200, settings.has(m[1]) ? { value: settings.get(m[1]), updatedAt: 't' } : { value: null, updatedAt: null });
      if (method === 'PUT') { settings.set(m[1], (body as { value: unknown }).value); return json(200, { value: settings.get(m[1]), updatedAt: 't' }); }
    }
    if (/\/assist$/.test(url) && method === 'POST') return json(200, { text: 'ok', usage: { inputTokens: 1, outputTokens: 1 }, ms: 1, model: 'fake' });
    if (/\/budget$/.test(url)) return json(200, { percentWeekly: 3, usdWeekly: 5, ...(body as object | undefined) });
    if (/\/assist\/(usage|share)/.test(url)) return json(200, { calls: 0 });
    if (/\/disable$/.test(url)) return json(200, { id: 'x', enabled: false });
    if (/\/files\/[^/]+$/.test(url) && method === 'DELETE') return { ok: true, status: 204, json: async () => null, text: async () => '', headers: new Headers() };
    if (/\/worker\//.test(url)) return json(200, { ok: true });
    return json(404, { error: 'nope' });
  });
  return { docs, settings, calls, fetch };
}

const terminal = (id: string, sessionId: string, extra: Record<string, unknown> = {}) =>
  ({ id, sessionId, type: 'claude-code', label: `Thread ${id}`, labelSource: 'user', pid: 123, externalId: 'ext', workingDir: '/secret/dir', status: 'waiting', createdAt: '2026-11-09T10:00:00Z', lastActivityAt: '2026-11-09T11:00:00Z', config: { transport: 'structured', secretish: 'x' }, archivedAt: null, sortOrder: 0, ...extra });
const session = (id: string, name: string) =>
  ({ id, provider: 'claude-code', name, notes: 'private notes', status: 'active', workingDir: `/w/${id}`, tags: ['t'], pid: 9, createdAt: 'c', updatedAt: 'u', lastActivityAt: 'l', archivedAt: null });

let daemon: ReturnType<typeof fakeDaemon>;
beforeEach(() => {
  daemon = fakeDaemon();
  vi.stubGlobal('fetch', daemon.fetch);
  usePluginRegistry.setState({ manifests: [], status: {}, views: [], settings: [], threadMenu: [], projectMenu: [], composerActions: [], slots: [], commands: [], inspectorTabs: [], badges: {} });
  useTabs.setState({ byProject: { s1: [terminal('t1', 's1'), terminal('t2', 's1', { archivedAt: '2026-11-01T00:00:00Z' })], s2: [terminal('t3', 's2', { type: 'codex' })] } as never });
  useProjects.setState({ sessions: [session('s1', 'Alpha'), session('s2', 'Beta')] as never, activeId: 's2' });
  useThreadStatus.setState({ byTerminal: {}, stalls: {} });
});
afterEach(() => { usePluginRegistry.getState().unregister('p'); usePluginRegistry.getState().unregister('q'); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const dataCalls = () => daemon.calls.filter((c) => /\/api\/plugins\//.test(c.url));

describe('createPluginSdk: the plugin id is bound (W3-F)', () => {
  it('docs.set calls the API with the bound plugin id', async () => {
    const d = createPluginSdk('p');
    await d.docs.set('pins', ['a']);
    const put = daemon.calls.find((c) => c.method === 'PUT')!;
    expect(put.url).toMatch(/\/api\/plugins\/p\/data\/pins$/);
    expect(put.body).toEqual({ value: ['a'] });
    expect(put.headers.get('X-Dispatch-Plugin')).toBe('p');
    expect(put.headers.get('X-Dispatch-Plugin-Bound')).toBe('p');
    expect(daemon.docs.get('p/pins')).toEqual(['a']);
  });

  it('a plugin cannot read the docs of another id', async () => {
    daemon.docs.set('q/secret', 'theirs');
    daemon.docs.set('p/own', 'mine');
    const d = createPluginSdk('p');
    // No parameter names a plugin: every function takes the key (and the value) only.
    expect(d.docs.get.length).toBeLessThanOrEqual(2);
    expect(d.docs.set.length).toBe(2);
    expect(d.docs.delete.length).toBe(1);
    expect(d.docs.keys.length).toBe(0);
    expect(d.docs.entries.length).toBe(0);
    // A v1-style call that passes an id first reads the KEY "q" of plugin p, never plugin q.
    expect(await (d.docs.get as unknown as (...a: unknown[]) => Promise<unknown>)('q', 'secret', 'fallback')).toBe('secret');
    expect(await d.docs.get('secret', 'none')).toBe('none');
    expect(await d.docs.get('own', 'none')).toBe('mine');
    expect(await d.docs.keys()).toEqual(['own']);
    expect(await d.docs.entries()).toEqual([{ key: 'own', value: 'mine' }]);
    // A key that tries to climb out stays one path segment of plugin p.
    expect(await d.docs.get('../../q/data/secret', 'none')).toBe('none');
    for (const c of dataCalls()) expect(c.url).toMatch(/\/api\/plugins\/p\/data(\/[^/]+)?(\?values=1)?$/);
    expect(daemon.docs.get('q/secret')).toBe('theirs');
  });

  it('a plugin cannot write or delete the docs of another id', async () => {
    daemon.docs.set('q/k', 'theirs');
    const d = createPluginSdk('p');
    await (d.docs.set as unknown as (...a: unknown[]) => Promise<void>)('q', 'k', 'stolen');
    await d.docs.delete('k');
    await d.docs.delete('../q/data/k');
    expect(daemon.docs.get('q/k')).toBe('theirs');
    for (const c of dataCalls()) expect(c.url).toMatch(/\/api\/plugins\/p\/data\//);
  });

  it('docs: get falls back on 404, delete of a missing key does not throw, two sets land in order', async () => {
    const d = createPluginSdk('p');
    expect(await d.docs.get('none', 7)).toBe(7);
    await expect(d.docs.delete('none')).resolves.toBeUndefined();
    const a = d.docs.set('k', 1); const b = d.docs.set('k', 2);
    await Promise.all([a, b]);
    expect(daemon.docs.get('p/k')).toBe(2);
  });

  it('settings.get and settings.set reach the settings of the bound id only', async () => {
    daemon.settings.set('q', { theirs: true });
    const d = createPluginSdk('p');
    expect(d.settings.set.length).toBe(1);
    expect(await d.settings.get({ hours: 24 })).toEqual({ hours: 24 });
    expect(await d.settings.get()).toBeNull();
    await d.settings.set({ hours: 48 });
    expect(await d.settings.get({ hours: 24 })).toEqual({ hours: 48 });
    expect(daemon.settings.get('q')).toEqual({ theirs: true });
    for (const c of dataCalls()) expect(c.url).toMatch(/\/api\/plugins\/p\/settings$/);
  });

  it('assist, model, plugin.disable and files reach the routes of the bound id', async () => {
    const d = createPluginSdk('p');
    expect((await d.assist({ messages: [{ role: 'user', content: 'x' }] })).text).toBe('ok');
    await d.model.usage({ from: '2026-11-01T00:00:00Z' });
    await d.model.share({ harness: 'codex' });
    await d.model.budget();
    expect(await d.model.setBudget({ usdWeekly: 9 })).toMatchObject({ usdWeekly: 9 });
    await d.plugin.disable();
    await d.files.remove('f1');
    expect(d.files.url('f 1')).toMatch(/\/api\/plugins\/p\/files\/f%201$/);
    expect(daemon.calls.map((c) => `${c.method} ${c.url.replace(/^.*\/api\/plugins\//, '')}`)).toEqual([
      'POST p/assist', 'GET p/assist/usage?from=2026-11-01T00%3A00%3A00Z', 'GET p/assist/share?harness=codex', 'GET p/budget', 'PUT p/budget', 'POST p/disable', 'DELETE p/files/f1',
    ]);
    for (const c of daemon.calls) expect(c.headers.get('X-Dispatch-Plugin-Bound')).toBe('p');
  });

  it('a failed call throws an error that carries the status and the daemon\'s words', async () => {
    daemon.fetch.mockImplementationOnce(async () => ({ ok: false, status: 429, json: async () => ({ error: 'budget' }), text: async () => '', headers: new Headers() }) as never);
    const d = createPluginSdk('p');
    await expect(d.assist({ messages: [] })).rejects.toMatchObject({ status: 429, message: expect.stringContaining('budget') });
  });

  it("worker.fetch targets the worker of the bound id; a path that climbs out is refused before any request", async () => {
    const d = createPluginSdk('p');
    await d.worker.fetch('jobs/run?x=1', { method: 'POST' });
    const c = daemon.calls.at(-1)!;
    expect(c.url).toMatch(/\/api\/plugins\/p\/worker\/jobs\/run\?x=1$/);
    expect(c.method).toBe('POST');
    expect(c.headers.get('X-Dispatch-Plugin-Bound')).toBe('p');
    const before = daemon.calls.length;
    for (const bad of ['../../q/data/secret', '../q/worker/x', 'a/../../../q/data', '%2e%2e/%2e%2e/q/data/k', '..\\..\\q\\data', 'a/%2E%2E/b', 'https://example.com/x', '//example.com/x']) {
      await expect(d.worker.fetch(bad)).rejects.toThrow(/own worker/);
    }
    expect(daemon.calls.length).toBe(before);
  });

  it('register takes the contributions only and registers under the bound id; setBadge reaches own views only', () => {
    const d = createPluginSdk('p');
    d.register({ views: [{ id: 'v', label: 'V', Component: () => null }] });
    expect(usePluginRegistry.getState().views.map((v) => v.key)).toEqual(['plugin:p:v']);
    d.actions.setBadge('v', 3);
    d.actions.setBadge('plugin:p:v', 4);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    d.actions.setBadge('plugin:q:v', 9);
    expect(usePluginRegistry.getState().badges).toEqual({ 'plugin:p:v': 4 });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('two objects are independent: each is bound to its own id', async () => {
    const p = createPluginSdk('p'); const q = createPluginSdk('q');
    await p.docs.set('k', 'from p'); await q.docs.set('k', 'from q');
    expect(daemon.docs.get('p/k')).toBe('from p');
    expect(daemon.docs.get('q/k')).toBe('from q');
    expect(p.id).toBe('p'); expect(q.id).toBe('q');
    expect(() => { (p as { id: string }).id = 'q'; }).toThrow();
    expect(() => { (p.docs as { get: unknown }).get = q.docs.get; }).toThrow();
  });
});

describe('createPluginSdk: the app\'s data as plain objects (W3-F)', () => {
  it('threads.list returns plain objects with the documented keys only', () => {
    const d = createPluginSdk('p');
    const list = d.threads.list();
    expect(list.map((t) => t.id)).toEqual(['t1', 't2', 't3']);
    for (const t of list) expect(Object.keys(t).sort()).toEqual(['archived', 'createdAt', 'id', 'kind', 'label', 'lastActivityAt', 'projectId', 'status']);
    expect(list[0]).toEqual({ id: 't1', projectId: 's1', label: 'Thread t1', kind: 'claude-code', status: 'waiting', archived: false, createdAt: '2026-11-09T10:00:00Z', lastActivityAt: '2026-11-09T11:00:00Z' });
    expect(list[1].archived).toBe(true);
    expect(d.threads.get('t3')).toMatchObject({ id: 't3', projectId: 's2', kind: 'codex' });
    expect(d.threads.get('nope')).toBeNull();
    // A copy: a plugin that changes it does not change the app's store.
    list[0].label = 'changed';
    expect((useTabs.getState().byProject.s1[0] as { label: string }).label).toBe('Thread t1');
  });

  it('threads.status merges the stored status with the live one', () => {
    const d = createPluginSdk('p');
    expect(d.threads.status('t1')).toEqual({ status: 'waiting', state: null, activity: null, stalledSince: null });
    useThreadStatus.setState({ byTerminal: { t1: { status: 'working', threadStatus: 'working', activity: 'Running: npm test' } }, stalls: { t1: 1234 } });
    expect(d.threads.status('t1')).toEqual({ status: 'working', state: 'working', activity: 'Running: npm test', stalledSince: 1234 });
    expect(d.threads.status('nope')).toBeNull();
  });

  it('threads.onChange fires on a status change and the returned function stops it', () => {
    const d = createPluginSdk('p');
    const fn = vi.fn();
    const off = d.threads.onChange(fn);
    useThreadStatus.getState().applyEvent({ type: 'terminal:status', terminalId: 't1', status: 'working' } as never);
    expect(fn).toHaveBeenCalledTimes(1);
    useTabs.setState({ byProject: { ...useTabs.getState().byProject, s2: [] } });
    expect(fn).toHaveBeenCalledTimes(2);
    off();
    useThreadStatus.getState().applyEvent({ type: 'terminal:status', terminalId: 't1', status: 'waiting' } as never);
    useTabs.setState({ byProject: {} });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('a threads.onChange listener is dropped when the plugin is unregistered', () => {
    const d = createPluginSdk('p');
    const fn = vi.fn();
    d.threads.onChange(fn);
    d.projects.onChange(fn);
    usePluginRegistry.getState().unregister('p');
    useTabs.setState({ byProject: {} });
    useProjects.setState({ sessions: [] });
    expect(fn).not.toHaveBeenCalled();
  });

  it('projects.list and projects.active return plain objects; projects.onChange fires and stops', () => {
    const d = createPluginSdk('p');
    expect(d.projects.list()).toEqual([{ id: 's1', name: 'Alpha', workingDir: '/w/s1', archived: false }, { id: 's2', name: 'Beta', workingDir: '/w/s2', archived: false }]);
    expect(d.projects.active()).toEqual({ id: 's2', name: 'Beta', workingDir: '/w/s2', archived: false });
    const fn = vi.fn();
    const off = d.projects.onChange(fn);
    useProjects.setState({ activeId: 's1' });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(d.projects.active()?.id).toBe('s1');
    off();
    useProjects.setState({ activeId: null });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(d.projects.active()).toBeNull();
  });

  it('hooks.useProjects and hooks.useThreads give the same plain objects and follow the stores', () => {
    const d = createPluginSdk('p');
    const projects = renderHook(() => d.hooks.useProjects());
    const threads = renderHook(() => d.hooks.useThreads());
    expect(projects.result.current.map((p) => p.name)).toEqual(['Alpha', 'Beta']);
    expect(threads.result.current.map((t) => t.id)).toEqual(['t1', 't2', 't3']);
    const first = projects.result.current;
    projects.rerender();
    expect(projects.result.current).toBe(first); // stable while the store did not change
    act(() => { useProjects.setState({ sessions: [session('s9', 'Gamma')] as never }); });
    expect(projects.result.current).toEqual([{ id: 's9', name: 'Gamma', workingDir: '/w/s9', archived: false }]);
    act(() => { useTabs.setState({ byProject: { s9: [terminal('t9', 's9')] } as never }); });
    expect(threads.result.current.map((t) => t.id)).toEqual(['t9']);
  });

  it('hooks.useDoc reads and writes a document of the bound id and refreshes on plugin:data for that id only', async () => {
    const d = createPluginSdk('p');
    daemon.docs.set('p/count', 1);
    const { result } = renderHook(() => d.hooks.useDoc<number>('count', 0));
    await waitFor(() => expect(result.current[0]).toBe(1));
    await act(async () => { await result.current[1](5); });
    expect(daemon.docs.get('p/count')).toBe(5);
    daemon.docs.set('p/count', 9);
    act(() => { applyPluginEvent({ type: 'plugin:data', id: 'q', key: 'count' }); });
    await new Promise((r) => setTimeout(r, 10));
    expect(result.current[0]).toBe(5);
    act(() => { applyPluginEvent({ type: 'plugin:data', id: 'p', key: 'count' }); });
    await waitFor(() => expect(result.current[0]).toBe(9));
  });
});

describe('createPluginSdk: navigation, hints, events (W3-F)', () => {
  it('navigate calls the navigation store', () => {
    const navigate = vi.fn();
    const before = useNavigation.getState().navigate;
    useNavigation.setState({ navigate });
    try {
      const d = createPluginSdk('p');
      d.navigate({ view: 'workspace', projectId: 's1', threadId: 't1' });
      expect(navigate).toHaveBeenCalledWith({ view: 'workspace', projectId: 's1', threadId: 't1' });
    } finally { useNavigation.setState({ navigate: before }); }
  });

  it('ui.hint shows the app\'s hint; url gives the app path', () => {
    const d = createPluginSdk('p');
    d.ui.hint('Saved.');
    expect(JSON.stringify(useHint.getState())).toContain('Saved.');
    expect(d.url('/api/plugins/p/files/f1')).toMatch(/\/api\/plugins\/p\/files\/f1$/);
  });

  it('events.on receives server events; the listener is dropped with the plugin', () => {
    const d = createPluginSdk('p');
    const got: string[] = [];
    const off = d.events.on(['thread:prompt', 'thread:turn'], (e) => got.push(e.type));
    d.events.on('plugin:data', (e) => got.push(e.type));
    applyPluginEvent({ type: 'thread:prompt', terminalId: 't1' });
    applyPluginEvent({ type: 'plugin:data', id: 'p', key: 'k' });
    expect(got).toEqual(['thread:prompt', 'plugin:data']);
    off();
    applyPluginEvent({ type: 'thread:prompt', terminalId: 't1' });
    expect(got).toHaveLength(2);
    usePluginRegistry.getState().unregister('p');
    applyPluginEvent({ type: 'plugin:data', id: 'p', key: 'k' });
    expect(got).toHaveLength(2);
  });

  it('the object has the documented keys only: version 2, no api, no stores, no storage, no fetch', () => {
    const d = createPluginSdk('p');
    expect(d.version).toBe(2);
    expect(Object.keys(d).sort()).toEqual([...SDK_V2_KEYS].sort());
    for (const k of ['api', 'stores', 'storage', 'fetch', 'apiPath', 'unregister']) expect(k in d).toBe(false);
    expect(Object.keys(d.hooks).sort()).toEqual(['useCallback', 'useContributions', 'useDoc', 'useEffect', 'useIsMobile', 'useMemo', 'useProjects', 'useRef', 'useState', 'useThreads']);
    expect('useStore' in d.hooks).toBe(false);
  });

  it('an empty or malformed plugin id is refused', () => {
    expect(() => createPluginSdk('')).toThrow();
    expect(() => createPluginSdk('../q')).toThrow();
    expect(() => createPluginSdk('a/b')).toThrow();
  });
});
