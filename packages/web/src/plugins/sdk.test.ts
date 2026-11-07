import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { buildSdk } from './sdk';
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
    m = /\/api\/plugins\/([^/]+)\/data$/.exec(url);
    if (m) return json(200, { docs: [...docs.keys()].filter((k) => k.startsWith(`${m![1]}/`)).map((k) => ({ key: k.split('/')[1], writer: null, updatedAt: 't', bytes: 1 })) });
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

  it('fetch adds the X-Dispatch-Plugin header', async () => {
    const d = buildSdk();
    await d.fetch('p', '/api/plugins/p/data');
    const init = daemon.fetch.mock.calls.at(-1)![1] as RequestInit;
    expect(new Headers(init.headers).get('X-Dispatch-Plugin')).toBe('p');
  });
});
