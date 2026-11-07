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
