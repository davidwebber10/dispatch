import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { render, screen, cleanup, act } from '@testing-library/react';
import { createPluginSdk, type DispatchSdkV2 } from './facade';
import { usePluginRegistry } from './registry';
import { reloadPlugin } from './host';
import { __resetDeprecationWarningsForTest } from './sdk';
import { useProjects } from '../stores/projects';
import type { PluginRow } from '../api/types';
// The bundled plugins are plain JS.
import activatePreviews from '../../../plugins/previews/web.js';
import activateCoach from '../../../plugins/coach/web.js';

/**
 * The facade covers what the bundled plugins use (engineering program 2026-11-09, W3-F). Each
 * bundle runs on the real version 2 object behind a recorder: a read of a member the object does
 * not have is written down. A bundle that still reached for `d.api`, `d.stores`, `d.storage` or a
 * call form of version 1 fails here with the member's name.
 */
const PLUGINS = path.resolve(__dirname, '../../../plugins');
const docsExamples = path.resolve(__dirname, '../../../../docs/plugins/examples');

/** Names a bundle may look up and not find: an icon by name, React's own probes of an object. */
const OPEN = new Set(['icons']);
function recording<T extends object>(target: T, missing: string[], at = 'd'): T {
  // A copy: a proxy over a frozen object must hand back the frozen members as they are.
  return new Proxy({ ...target }, {
    get(obj, key, receiver) {
      const value = Reflect.get(obj, key, receiver) as unknown;
      if (typeof key === 'symbol') return value;
      if (!(key in obj)) { if (key !== 'then' && key !== 'toJSON' && key !== '$$typeof') missing.push(`${at}.${key}`); return value; }
      // Wrap the SDK's own namespaces only: plain frozen objects. React, the icons and the controls pass as they are.
      const plain = value !== null && typeof value === 'object' && Object.isFrozen(value) && Object.getPrototypeOf(value) === Object.prototype;
      return plain && !OPEN.has(key) && key !== 'ui' ? recording(value as object, missing, `${at}.${key}`) : value;
    },
  });
}

interface Fake { calls: string[]; bound: (string | null)[] }
function fakeDaemon(docs: Record<string, unknown> = {}): Fake {
  const out: Fake = { calls: [], bound: [] };
  const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body), headers: new Headers() });
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input); const method = (init?.method ?? 'GET').toUpperCase();
    out.calls.push(`${method} ${url}`);
    out.bound.push(new Headers(init?.headers).get('X-Dispatch-Plugin-Bound'));
    let m = /\/data\/([^/?]+)$/.exec(url);
    if (m) { const k = decodeURIComponent(m[1]); return method === 'GET' ? (k in docs ? json(200, { key: k, value: docs[k] }) : json(404, { error: 'document not found' })) : json(200, { key: k, value: null }); }
    m = /\/data(\?values=1)?$/.exec(url);
    if (m) return json(200, { docs: Object.entries(docs).map(([key, value]) => ({ key, value })) });
    if (/\/settings$/.test(url)) return json(200, { value: null, updatedAt: null });
    if (/\/budget$/.test(url)) return json(200, { percentWeekly: 3, usdWeekly: 5 });
    if (/\/assist\/usage/.test(url)) return json(200, { calls: 0, failed: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, byModel: [] });
    if (/\/assist\/share/.test(url)) return json(200, { fiveHour: null, sevenDay: null });
    return json(404, { error: 'nope' });
  }));
  return out;
}
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });
const contributions = () => { const s = usePluginRegistry.getState(); return { views: s.views, settings: s.settings, slots: s.slots, inspectorTabs: s.inspectorTabs, threadMenu: s.threadMenu, projectMenu: s.projectMenu, commands: s.commands }; };

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  __resetDeprecationWarningsForTest();
  usePluginRegistry.setState({ manifests: [], status: {}, views: [], settings: [], threadMenu: [], projectMenu: [], composerActions: [], slots: [], commands: [], inspectorTabs: [], badges: {} });
  useProjects.setState({ sessions: [{ id: 's1', name: 'Alpha', workingDir: '/a', archivedAt: null }, { id: 's2', name: 'Beta', workingDir: '/b', archivedAt: null }] as never, activeId: 's1' });
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { cleanup(); usePluginRegistry.getState().unregister('previews'); usePluginRegistry.getState().unregister('coach'); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('the bundled plugins run on SDK version 2 (W3-F)', () => {
  it('every bundled manifest says "sdk": 2, and no bundle names api, stores or the version 1 call forms', () => {
    const ids = fs.readdirSync(PLUGINS).filter((n) => fs.existsSync(path.join(PLUGINS, n, 'plugin.json')));
    expect(ids.sort()).toEqual(['coach', 'previews']);
    for (const id of ids) {
      const manifest = JSON.parse(fs.readFileSync(path.join(PLUGINS, id, 'plugin.json'), 'utf8')) as { sdk?: number };
      expect(manifest.sdk, `${id}/plugin.json`).toBe(2);
      const src = fs.readFileSync(path.join(PLUGINS, id, 'web.js'), 'utf8');
      for (const banned of [/\bd\.api\b/, /\bd\.stores\b/, /\bd\.storage\b/, /\bd\.fetch\b/, /\bd\.apiPath\b/, /\bd\.hint\b/, /\bd\.copyText\b/, /window\.dispatch/, /\bregister\(\s*(ID|PLUGIN)\b/, /storage\.\w+\(\s*(ID|PLUGIN)\b/, /settings\.(get|set)\(\s*(ID|PLUGIN)\b/, /assist\(\s*(ID|PLUGIN)\b/]) {
        expect(src, `${id}/web.js has ${String(banned)}`).not.toMatch(banned);
      }
    }
  });

  it('the example plugins of the developer document are on version 2 as well', () => {
    for (const id of fs.readdirSync(docsExamples)) {
      const manifest = JSON.parse(fs.readFileSync(path.join(docsExamples, id, 'plugin.json'), 'utf8')) as { sdk?: number };
      expect(manifest.sdk, `${id}/plugin.json`).toBe(2);
      const src = fs.readFileSync(path.join(docsExamples, id, 'web.js'), 'utf8');
      for (const banned of [/\bapi\./, /\bd\.stores\b/, /\bstorage\./, /\bd\.hint\b/, /register\(\s*(ID|PLUGIN|d\.id|')/]) expect(src, `${id}/web.js has ${String(banned)}`).not.toMatch(banned);
    }
  });

  it('Previews: every surface renders on the version 2 object and reads no member the object lacks', async () => {
    const preview = (n: number) => ({ id: `p${n}`, sessionId: 's1', sessionName: 'Alpha', terminalId: 't1', terminalLabel: 'Fix login', title: `Preview ${n}`, note: 'a note', text: 'plain text', files: [{ fileId: `f${n}`, name: 'shot.png', mime: 'image/png', size: 10 }], createdAt: new Date(Date.UTC(2026, 10, 9, 12, 0, 60 - n)).toISOString(), seenAt: n % 2 ? null : 'seen' });
    const daemon = fakeDaemon(Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`preview:p${i + 1}`, preview(i + 1)])));
    const missing: string[] = [];
    activatePreviews(recording(createPluginSdk('previews'), missing));
    const c = contributions();
    // The badge on the rail item: the unseen count, on the plugin's own view (closing the screen marks them seen).
    await vi.waitFor(() => expect(usePluginRegistry.getState().badges['plugin:previews:history']).toBe(13));
    expect(c.views.map((v) => v.key)).toEqual(['plugin:previews:history']);
    expect(c.inspectorTabs.map((t) => t.key)).toEqual(['plugin:previews:thread']);
    expect(c.projectMenu).toHaveLength(1);
    expect(c.slots.map((s) => s.slot).sort()).toEqual(['app.overlay', 'project.header.actions']);

    // The Previews screen: a page of 20, then Show older.
    const History = c.views[0].Component;
    render(<History />);
    await screen.findByText('Preview 1');
    expect(screen.getAllByTestId('preview-item')).toHaveLength(20);
    const older = screen.getByRole('button', { name: /Show older \(5 more\)/ });
    await act(async () => { older.click(); });
    expect(screen.getAllByTestId('preview-item')).toHaveLength(25);
    expect(screen.queryByRole('button', { name: /Show older/ })).toBeNull();
    // A file's address comes from the bound object.
    expect(document.querySelector('img')!.getAttribute('src')).toMatch(/\/api\/plugins\/previews\/files\/f1\?thumb=480$/); // a card shows the small copy (2026-11-09)
    cleanup();

    // The right-column tab of a thread.
    const Tab = c.inspectorTabs[0].Component;
    render(<Tab terminalId="t1" sessionId="s1" />);
    expect((await screen.findAllByTestId('preview-item')).length).toBeGreaterThan(0);
    cleanup();

    // The project's eye and its sheet.
    const Eye = c.slots.find((s) => s.slot === 'project.header.actions')!.Component;
    const Sheet = c.slots.find((s) => s.slot === 'app.overlay')!.Component;
    render(<><Eye session={{ id: 's1' }} /><Sheet /></>);
    const eye = screen.getByRole('button', { name: 'Previews' });
    await act(async () => { eye.click(); });
    await screen.findByText('Previews · Alpha');
    expect(screen.getAllByTestId('preview-item')).toHaveLength(20);
    expect(screen.getByRole('button', { name: /Show older \(5 more\)/ })).toBeTruthy();
    // Delete: the document and the file reference go through the bound routes.
    await act(async () => { screen.getAllByRole('button', { name: 'Delete preview' })[0].click(); });
    await settle();
    expect(daemon.calls).toContain('DELETE /api/plugins/previews/data/preview%3Ap1');
    expect(daemon.calls).toContain('DELETE /api/plugins/previews/files/f1');

    expect(missing).toEqual([]);
    expect(daemon.calls.every((call) => /\/api\/plugins\/previews\//.test(call))).toBe(true);
    expect(daemon.bound.every((b) => b === 'previews')).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('Coach: the view, the tab, the settings and the card render on the version 2 object and read no member the object lacks', async () => {
    const daemon = fakeDaemon({ cadence: { v: 1, startedAt: '2026-10-01T00:00:00.000Z', welcomeDone: false } });
    const missing: string[] = [];
    activateCoach(recording(createPluginSdk('coach'), missing));
    await settle();
    const c = contributions();
    expect(c.views.map((v) => v.key)).toEqual(['plugin:coach:coach']);
    expect(c.settings.map((s) => s.key)).toEqual(['plugin:coach:coach']);
    expect(c.slots.map((s) => s.slot)).toContain('composer.before');

    const View = c.views[0].Component;
    render(<View />);
    await settle();
    expect(document.body.textContent).toMatch(/Coach/);
    cleanup();

    const Settings = c.settings[0].Component;
    render(<Settings />);
    await settle();
    expect(document.body.textContent).toMatch(/Projects/);
    expect(document.body.textContent).toMatch(/All projects/); // the projects come from d.hooks.useProjects
    cleanup();

    for (const tab of c.inspectorTabs) { const T = tab.Component; render(<T terminalId="t1" sessionId="s1" />); await settle(); cleanup(); }
    for (const slot of c.slots) {
      const S = slot.Component as React.ComponentType<Record<string, unknown>>;
      render(<S surface="thread" terminalId="t1" sessionId="s1" value="" insert={() => {}} set={() => {}} />);
      await settle();
      cleanup();
    }
    for (const cmd of c.commands) expect(typeof cmd.run).toBe('function');

    expect(missing).toEqual([]);
    // Every request is bound, and a request bound to the Coach names the Coach's routes only. (A late
    // write of the Previews test before this one can land here: it is bound to Previews.)
    const mine = daemon.calls.filter((_, i) => daemon.bound[i] === 'coach');
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.filter((call) => !/\/api\/plugins\/coach\//.test(call))).toEqual([]);
    expect(daemon.bound.filter((b) => b === null)).toEqual([]);
    expect(daemon.calls.filter((call, i) => !call.includes(`/api/plugins/${daemon.bound[i]}/`))).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('through the host: both bundles load from their manifests with no warning and no error', async () => {
    fakeDaemon();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rowOf = (id: string): PluginRow => ({ ...(JSON.parse(fs.readFileSync(path.join(PLUGINS, id, 'plugin.json'), 'utf8')) as PluginRow), enabled: true, stamp: 1, install: null });
    const got: Record<string, DispatchSdkV2> = {};
    const importer = async (url: string) => {
      const id = /plugins\/([^/]+)\//.exec(url)![1];
      const activate = id === 'coach' ? activateCoach : activatePreviews;
      return { default: (d: DispatchSdkV2) => { got[id] = d; activate(d); } };
    };
    await reloadPlugin(rowOf('previews'), importer);
    await reloadPlugin(rowOf('coach'), importer);
    await settle();
    const s = usePluginRegistry.getState();
    expect(s.status.previews.state).toBe('ready');
    expect(s.status.coach.state).toBe('ready');
    expect(got.previews.version).toBe(2);
    expect(got.coach.version).toBe(2);
    expect('api' in got.coach).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
