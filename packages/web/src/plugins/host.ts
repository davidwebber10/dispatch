import { apiPath } from '../lib/basePath';
import type { ServerEvent } from '../api/events-socket';
import type { PluginRow } from '../api/types';
import { usePluginRegistry, isPluginView, pluginView } from './registry';
import { useUI } from '../stores/ui';
import { installSdk, notifyDocChanged, dispatchServerEvent, type DispatchSdk } from './sdk';

/**
 * Plugins (docs/superpowers/specs/2026-11-07-plugins-design.md, section 2.1): loads every enabled
 * plugin's web bundle into the app and reloads one when the daemon says its files changed. The
 * bundle is a same-origin ES module (`/plugins/<id>/<web>`), so the app's CSP allows it, and
 * `?v=<stamp>` defeats the cache on a reload.
 *
 * A bundle's default export is `activate(sdk)`; it registers the plugin's contributions. A
 * bundle with no default export may call `window.dispatch.register` at load time instead.
 */
export type Importer = (url: string) => Promise<unknown>;

const SAFE_FLAG = 'dispatch:plugins:safe';
const defaultImporter: Importer = (url) => import(/* @vite-ignore */ url);

/** `?safe` in the URL, or the Settings switch: no plugin loads. */
export function isSafeMode(): boolean {
  try { if (typeof location !== 'undefined' && /[?&]safe(?:[=&]|$)/.test(location.search)) return true; } catch { /* ignore */ }
  try { return localStorage.getItem(SAFE_FLAG) === '1'; } catch { return false; }
}

export function setSafeMode(on: boolean): void {
  try { if (on) localStorage.setItem(SAFE_FLAG, '1'); else localStorage.removeItem(SAFE_FLAG); } catch { /* ignore */ }
}

export async function loadPlugins(importer: Importer = defaultImporter): Promise<void> {
  if (isSafeMode()) return;
  let rows: PluginRow[];
  try {
    const res = await fetch(apiPath('/api/plugins'));
    if (!res.ok) return;
    rows = ((await res.json()) as { plugins: PluginRow[] }).plugins ?? [];
  } catch { return; }
  usePluginRegistry.getState().setManifests(rows);
  await Promise.all(rows.map((m) => reloadPlugin(m, importer)));
  // A view saved for a plugin that did not load (disabled, broken, removed) would show a bare
  // line on every launch: the workspace is the safe landing. Only once the loads are done, so a
  // slow plugin keeps its saved view.
  const view = useUI.getState().view;
  if (isPluginView(view) && !pluginView(view)) useUI.getState().setView('workspace');
}

/** Load (or load again) one plugin from its row. Never throws: a failure becomes the plugin's status. */
export async function reloadPlugin(m: PluginRow, importer: Importer = defaultImporter): Promise<void> {
  const reg = usePluginRegistry.getState();
  const at = Date.now();
  reg.unregister(m.id);
  if (m.error) { reg.setStatus(m.id, { state: 'error', error: m.error, version: m.version, at }); return; }
  if (!m.enabled) { reg.setStatus(m.id, { state: 'error', error: 'disabled', version: m.version, at }); return; }
  if (!m.web) { reg.setStatus(m.id, { state: 'ready', version: m.version, at }); return; }
  reg.setStatus(m.id, { state: 'loading', version: m.version, at });
  // The bundle's `register` is bound to its own id: a copied plugin that still says the old id
  // cannot register under another plugin (spec section 14), nor unregister one.
  const base = installSdk();
  const sdk: DispatchSdk = {
    ...base,
    register: (id, c) => {
      if (id !== m.id) throw new Error(`The bundle registered as "${id}" but plugin.json says "${m.id}". A plugin registers under its own id.`);
      base.register(id, c);
    },
    unregister: (id) => { if (id === m.id) base.unregister(id); else console.warn(`[plugin ${m.id}] tried to unregister "${id}"; ignored`); },
  };
  const url = `${apiPath(`/plugins/${encodeURIComponent(m.id)}/${m.web}`)}?v=${m.stamp}`;
  try {
    const mod = (await importer(url)) as { default?: (sdk: DispatchSdk) => unknown } | null;
    if (mod && typeof mod.default === 'function') await mod.default(sdk);
    usePluginRegistry.getState().setStatus(m.id, { state: 'ready', version: m.version, at: Date.now() });
  } catch (e) {
    usePluginRegistry.getState().unregister(m.id);
    usePluginRegistry.getState().setStatus(m.id, { state: 'error', error: e instanceof Error ? e.message : String(e), version: m.version, at: Date.now() });
    console.error(`[plugin ${m.id}] failed to load`, e);
  }
}

/** `plugin:changed` from the daemon: the plugin's files changed, its state changed, or it was removed. */
export function applyPluginEvent(e: ServerEvent, importer: Importer = defaultImporter): void {
  // Every server event reaches the plugins' listeners (the SDK's events.on), safe mode or not for plugins already loaded.
  dispatchServerEvent(e);
  if (e.type === 'plugin:data' && typeof e.id === 'string' && typeof e.key === 'string') { notifyDocChanged(e.id, e.key); return; }
  if (e.type !== 'plugin:changed' || typeof e.id !== 'string' || isSafeMode()) return;
  const reg = usePluginRegistry.getState();
  const m = (e.plugin ?? null) as PluginRow | null;
  if (!m) {
    reg.unregister(e.id);
    reg.setManifests(reg.manifests.filter((x) => x.id !== e.id));
    const status = { ...reg.status }; delete status[e.id];
    usePluginRegistry.setState({ status });
    return;
  }
  reg.setManifests([...reg.manifests.filter((x) => x.id !== m.id), m].sort((a, b) => a.id.localeCompare(b.id)));
  void reloadPlugin(m, importer);
}
