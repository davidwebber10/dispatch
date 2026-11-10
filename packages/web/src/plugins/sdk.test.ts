import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { buildSdk, createLegacySdk, __resetDeprecationWarningsForTest } from './sdk';
import { createPluginSdk } from './facade';
import { api } from '../api/client';
import { useProjects } from '../stores/projects';
import { applyPluginEvent } from './host';

/** A fake daemon for the plugin storage routes: documents live in a map; every call is recorded. */
function fakeDaemon() {
  const docs = new Map<string, unknown>();
  const settings = new Map<string, unknown>();
  const calls: string[] = [];
  const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body), headers: new Headers({ 'content-type': 'application/json' }) });
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input); const method = (init?.method ?? 'GET').toUpperCase();
    calls.push(`${method} ${url}`);
    let m = /\/api\/plugins\/([^/]+)\/data\/([^/?]+)$/.exec(url);
    if (m) {
      const k = `${m[1]}/${m[2]}`;
      if (method === 'GET') return docs.has(k) ? json(200, { key: m[2], value: docs.get(k), writer: null, updatedAt: 't', bytes: 1 }) : json(404, { error: 'document not found' });
      if (method === 'PUT') { const body = JSON.parse(String(init?.body)) as { value: unknown }; await new Promise((r) => setTimeout(r, 5)); docs.set(k, body.value); return json(200, { key: m[2], value: body.value, writer: null, updatedAt: 't', bytes: 1 }); }
      if (method === 'DELETE') { const had = docs.delete(k); return had ? { ok: true, status: 204, json: async () => null, text: async () => '', headers: new Headers() } : json(404, {}); }
    }
    m = /\/api\/plugins\/([^/]+)\/data(\?values=1)?$/.exec(url);
    if (m) return json(200, { docs: [...docs.keys()].filter((k) => k.startsWith(`${m![1]}/`)).map((k) => ({ key: k.split('/')[1], writer: null, updatedAt: 't', bytes: 1, ...(m![2] ? { value: docs.get(k) } : {}) })) });
    m = /\/api\/plugins\/([^/]+)\/assist$/.exec(url);
    if (m && method === 'POST') { const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] }; return json(200, { text: `judged: ${body.messages[0].content}`, usage: { inputTokens: 10, outputTokens: 5 }, ms: 100, model: 'fake' }); }
    m = /\/api\/plugins\/([^/]+)\/settings$/.exec(url);
    if (m) {
      if (method === 'GET') return json(200, settings.has(m[1]) ? { value: settings.get(m[1]), updatedAt: 't' } : { value: null, updatedAt: null });
      if (method === 'PUT') { const body = JSON.parse(String(init?.body)) as { value: unknown }; settings.set(m[1], body.value); return json(200, { value: body.value, updatedAt: 't' }); }
    }
    return json(404, { error: 'nope' });
  });
  return { docs, settings, calls, fetch };
}

let daemon: ReturnType<typeof fakeDaemon>;
beforeEach(() => { daemon = fakeDaemon(); vi.stubGlobal('fetch', daemon.fetch); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('plugin SDK storage on the daemon (2026-11-07)', () => {
  it('storage.get returns the fallback on 404 and the value on 200; set writes { value }; list and remove work', async () => {
    const d = buildSdk();
    expect(await d.storage.get('p', 'pins', [])).toEqual([]);
    await d.storage.set('p', 'pins', ['a']);
    expect(daemon.docs.get('p/pins')).toEqual(['a']);
    expect(await d.storage.get('p', 'pins', [])).toEqual(['a']);
    expect(await d.storage.list('p')).toEqual(['pins']);
    await d.storage.remove('p', 'pins');
    expect(await d.storage.get('p', 'pins', 'gone')).toBe('gone');
  });

  it('storage.all returns every document with its value in one call; apiPath prefixes the app base', async () => {
    const d = fakeDaemon(); vi.stubGlobal('fetch', d.fetch);
    const sdk = buildSdk();
    await sdk.storage.set('p', 'x', 1); await sdk.storage.set('p', 'y', { z: 2 });
    expect(await sdk.storage.all('p')).toEqual([{ key: 'x', value: 1 }, { key: 'y', value: { z: 2 } }]);
    expect(d.calls.filter((c) => c.includes('values=1'))).toHaveLength(1);
    expect(sdk.apiPath('/api/plugins/p/files/f1')).toMatch(/\/api\/plugins\/p\/files\/f1$/);
  });

  it('two sets in a row land in order', async () => {
    const d = buildSdk();
    const a = d.storage.set('p', 'k', 1);
    const b = d.storage.set('p', 'k', 2);
    await Promise.all([a, b]);
    expect(daemon.docs.get('p/k')).toBe(2);
    const puts = daemon.calls.filter((c) => c.startsWith('PUT'));
    expect(puts).toHaveLength(2);
  });

  it('settings round-trip', async () => {
    const d = buildSdk();
    expect(await d.settings.get('p', { hours: 24 })).toEqual({ hours: 24 });
    await d.settings.set('p', { hours: 48 });
    expect(await d.settings.get('p', { hours: 24 })).toEqual({ hours: 48 });
  });

  it('useDoc loads, sets, and refreshes when plugin:data names its key', async () => {
    const d = buildSdk();
    daemon.docs.set('p/count', 1);
    const { result } = renderHook(() => d.hooks.useDoc<number>('p', 'count', 0));
    expect(result.current[2]).toBe(true); // loading
    await waitFor(() => expect(result.current[0]).toBe(1));
    expect(result.current[2]).toBe(false);
    await act(async () => { await result.current[1](5); });
    expect(result.current[0]).toBe(5);
    expect(daemon.docs.get('p/count')).toBe(5);
    daemon.docs.set('p/count', 9); // another client wrote
    act(() => { applyPluginEvent({ type: 'plugin:data', id: 'p', key: 'count' }); });
    await waitFor(() => expect(result.current[0]).toBe(9));
    act(() => { applyPluginEvent({ type: 'plugin:data', id: 'p', key: 'other' }); });
    expect(result.current[0]).toBe(9);
  });

  it("worker.fetch targets the plugin's worker proxy with the plugin header", async () => {
    const d = buildSdk();
    await d.worker.fetch('p', 'jobs/run?x=1', { method: 'POST' });
    const [url, init] = daemon.fetch.mock.calls.at(-1)! as [string, RequestInit];
    expect(url).toMatch(/\/api\/plugins\/p\/worker\/jobs\/run\?x=1$/);
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('X-Dispatch-Plugin')).toBe('p');
  });

  it('fetch adds the X-Dispatch-Plugin header', async () => {
    const d = buildSdk();
    await d.fetch('p', '/api/plugins/p/data');
    const init = daemon.fetch.mock.calls.at(-1)![1] as RequestInit;
    expect(new Headers(init.headers).get('X-Dispatch-Plugin')).toBe('p');
  });
});

describe('plugin SDK events and assist (2026-11-07)', () => {
  it('events.on receives thread events (and any event type asked for) and unsubscribes', () => {
    const d = buildSdk();
    const got: unknown[] = [];
    const off = d.events.on(['thread:prompt', 'thread:turn'], (e) => got.push(e));
    applyPluginEvent({ type: 'thread:prompt', terminalId: 't1', text: 'hi', textLength: 2 });
    applyPluginEvent({ type: 'thread:tool', terminalId: 't1', tool: 'Bash' });
    applyPluginEvent({ type: 'thread:turn', terminalId: 't1', ms: 5 });
    expect(got.map((e) => (e as { type: string }).type)).toEqual(['thread:prompt', 'thread:turn']);
    off();
    applyPluginEvent({ type: 'thread:prompt', terminalId: 't1', text: 'again', textLength: 5 });
    expect(got).toHaveLength(2);
    const all: unknown[] = [];
    const offAll = d.events.on('*', (e) => all.push(e));
    applyPluginEvent({ type: 'terminal:status', terminalId: 't1' });
    expect(all).toHaveLength(1);
    offAll();
  });

  it('assist posts the request and returns the text and usage', async () => {
    const d = buildSdk();
    const r = await d.assist('coach', { system: 'Judge.', messages: [{ role: 'user', content: 'Fix it' }], maxTokens: 200 });
    expect(r).toEqual({ text: 'judged: Fix it', usage: { inputTokens: 10, outputTokens: 5 }, ms: 100, model: 'fake' });
    const call = daemon.calls.find((c) => c.includes('/assist'));
    expect(call).toMatch(/^POST .*\/api\/plugins\/coach\/assist$/);
  });
});

describe('plugin SDK settings primitives (coach settings cleanup, 2026-11-07)', () => {
  it('ui carries the shared MultiSelect, Segmented, SettingsGroup and SettingsRow', () => {
    const d = buildSdk();
    for (const k of ['MultiSelect', 'Segmented', 'SettingsGroup', 'SettingsRow'] as const) expect(typeof (d.ui as Record<string, unknown>)[k]).toBe('function');
  });
});

describe('the version 1 compatibility shim (engineering program 2026-11-09, W3-F)', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { __resetDeprecationWarningsForTest(); warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warn.mockRestore(); });

  it('the first read of sdk.api by a v1 plugin warns once', () => {
    const d = createLegacySdk('old-plugin');
    expect(warn).not.toHaveBeenCalled(); // building the object reads nothing
    expect(d.api).toBe(api);
    expect(d.api.listPlugins).toBe(api.listPlugins);
    void d.api;
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain('old-plugin');
    expect(line).toContain('sdk.api');
    expect(line).toMatch(/docs|settings|worker/); // the replacement
    expect(line).toMatch(/next major/);
    // A reload hands the bundle a new object: the same plugin does not warn again.
    void createLegacySdk('old-plugin').api;
    expect(warn).toHaveBeenCalledTimes(1);
    // Another plugin gets its own warning.
    void createLegacySdk('other-plugin').api;
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[1][0])).toContain('other-plugin');
  });

  it('the first read of sdk.stores by a v1 plugin warns once, and names threads and projects', () => {
    const d = createLegacySdk('old-plugin');
    expect(d.stores.useProjects).toBe(useProjects);
    void d.stores.useTabs; void d.stores;
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain('old-plugin');
    expect(line).toContain('sdk.stores');
    expect(line).toMatch(/threads/);
    expect(line).toMatch(/projects/);
  });

  it('a v1 plugin that reads neither api nor stores logs nothing, and everything else works as before', async () => {
    const d = createLegacySdk('p');
    expect(d.id).toBe('p');
    expect(d.version).toBe('1.0');
    await d.storage.set('p', 'k', 1);
    expect(await d.storage.get('p', 'k', 0)).toBe(1);
    expect(await d.storage.list('p')).toEqual(['k']);
    expect(await d.storage.all('p')).toEqual([{ key: 'k', value: 1 }]);
    await d.settings.set('p', { a: 1 });
    expect(await d.settings.get('p', null)).toEqual({ a: 1 });
    await d.fetch('p', '/api/plugins/p/data');
    await d.worker.fetch('p', 'x');
    await d.assist('p', { messages: [{ role: 'user', content: 'hi' }] });
    d.hint('x'); expect(typeof d.copyText).toBe('function'); expect(typeof d.apiPath).toBe('function');
    expect(warn).not.toHaveBeenCalled();
  });

  it('a v1 plugin cannot act as another plugin: storage, settings, assist, fetch and worker refuse another id before any request', async () => {
    const d = createLegacySdk('p');
    daemon.docs.set('q/secret', 'theirs');
    const before = daemon.calls.length;
    await expect(d.storage.get('q', 'secret', null)).rejects.toThrow(/"p".*"q"|"q".*"p"/);
    await expect(d.storage.set('q', 'secret', 'stolen')).rejects.toThrow(/its own id/);
    await expect(d.storage.remove('q', 'secret')).rejects.toThrow(/its own id/);
    await expect(d.storage.list('q')).rejects.toThrow(/its own id/);
    await expect(d.storage.all('q')).rejects.toThrow(/its own id/);
    await expect(d.settings.get('q', null)).rejects.toThrow(/its own id/);
    await expect(d.settings.set('q', {})).rejects.toThrow(/its own id/);
    await expect(d.assist('q', { messages: [] })).rejects.toThrow(/its own id/);
    await expect(d.fetch('q', '/api/plugins/q/data')).rejects.toThrow(/its own id/);
    await expect(d.worker.fetch('q', 'x')).rejects.toThrow(/its own id/);
    expect(daemon.calls.length).toBe(before);
    expect(daemon.docs.get('q/secret')).toBe('theirs');
  });

  it('a v2 plugin object has no api and no stores key', () => {
    const d = createPluginSdk('p') as unknown as Record<string, unknown>;
    expect('api' in d).toBe(false);
    expect('stores' in d).toBe(false);
    expect(d.api).toBeUndefined();
    expect(d.stores).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('the shared window.dispatch object also warns once for api and once for stores', () => {
    const d = buildSdk();
    void d.api; void d.api; void d.stores; void d.stores;
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0][0])).toContain('window.dispatch');
  });
});
