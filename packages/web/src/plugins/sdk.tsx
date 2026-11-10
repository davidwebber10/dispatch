import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { create, type StoreApi, type UseBoundStore } from 'zustand';
import * as Icons from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
import { api, ApiError, type PluginAssistRequest } from '../api/client';
import type { ServerEvent } from '../api/events-socket';
import { apiPath } from '../lib/basePath';
import { useUI } from '../stores/ui';
import { useProjects } from '../stores/projects';
import { useTabs } from '../stores/tabs';
import { useUpdate } from '../stores/update';
import { useThreadStatus } from '../stores/threadStatus';
import { useHint } from '../stores/hint';
import { useIsMobile } from '../hooks/useIsMobile';
import { Modal } from '../components/common/Modal';
import { FilterBar } from '../components/common/FilterBar';
import { Select } from '../components/common/Select';
import { MultiSelect } from '../components/common/MultiSelect';
import { Segmented } from '../components/common/Segmented';
import { Markdown } from '../components/Markdown';
import { FileViewer } from '../components/viewer/FileViewer';
import { copyText } from '../lib/clipboard';
import { openThreadInPlace } from '../components/endless/openThread';
import { sectionLabel, row, item, ghostBtn, solidBtn, chip, fieldInput, Toggle, SettingsGroup, SettingsRow } from '../components/settings/ui';
import { usePluginRegistry, useContributions, type Contributions, type InspectorTabIcon } from './registry';
import { usePluginDialogs } from './PluginDialogs';

/**
 * Plugins (docs/superpowers/specs/2026-11-07-plugins-design.md, section 2.2): the object a plugin's
 * bundle finds at `window.dispatch`. A bundle ships no React or zustand; it uses the app's through
 * this object, so its screens share the app's React tree, styles and stores. `register` is the
 * one write; everything else is what the app already has.
 *
 * Two versions (engineering program 2026-11-09, W3-F). This file builds VERSION 1: the object a
 * plugin whose manifest says `sdk: 1` (or nothing) gets, and the shared `window.dispatch`. It hands
 * out the app's API client and stores, so it is kept for one release only: `api` and `stores` are
 * getters that log one warning for each plugin, and they go away in the next major version.
 * VERSION 2 is facade.ts (`createPluginSdk`): the plugin id is bound and no store or client leaves
 * the app. The pieces both versions share (icons, events, the write queue, the controls) are here.
 */
export const SDK_VERSION = '1.0';

export const ICONS: Record<string, Icon> = {
  puzzle: Icons.PuzzlePiece, sun: Icons.Sun, star: Icons.Star, sparkle: Icons.Sparkle, lightning: Icons.Lightning,
  calendar: Icons.Calendar, clock: Icons.Clock, note: Icons.Note, rocket: Icons.Rocket, flag: Icons.Flag, heart: Icons.Heart,
  folder: Icons.Folder, terminal: Icons.TerminalWindow, git: Icons.GitBranch, cloud: Icons.Cloud, database: Icons.Database,
  bell: Icons.Bell, chart: Icons.ChartBar, list: Icons.ListChecks, play: Icons.Play, gear: Icons.Gear, eye: Icons.Eye,
  chat: Icons.ChatCircleDots, book: Icons.BookOpen, bug: Icons.Bug, shield: Icons.ShieldCheck, globe: Icons.Globe, wrench: Icons.Wrench,
  copy: Icons.Copy, check: Icons.Check, trash: Icons.Trash, image: Icons.Image, file: Icons.FileText, pdf: Icons.FilePdf, html: Icons.FileHtml, csv: Icons.FileCsv, x: Icons.X,
  'thumbs-up': Icons.ThumbsUp, 'thumbs-down': Icons.ThumbsDown, dots: Icons.DotsThree, 'bell-slash': Icons.BellSlash,
  'arrow-up': Icons.ArrowUp, 'arrow-down': Icons.ArrowDown, 'arrow-right': Icons.ArrowRight, target: Icons.Target, plus: Icons.Plus, 'caret-down': Icons.CaretDown, 'caret-right': Icons.CaretRight,
};
export const pluginIcon = (name: string | undefined): Icon => (name && ICONS[name]) || Icons.PuzzlePiece;
/** A right-column tab's icon: a name from the list above, or the phosphor component itself. */
export const tabIcon = (icon: InspectorTabIcon | undefined): Icon => (typeof icon === 'string' || !icon ? pluginIcon(icon) : (icon as Icon));

/**
 * Per-plugin storage on the daemon (spec section 5). Writes queue per plugin so two sets in a row
 * land in order; a read waits for the queued writes of that plugin.
 */
const queues = new Map<string, Promise<unknown>>();
export function queued<T>(plugin: string, work: () => Promise<T>): Promise<T> {
  const prev = queues.get(plugin) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(work);
  queues.set(plugin, next);
  return next;
}
const storage = {
  async get<T = unknown>(plugin: string, key: string, fallback: T): Promise<T> {
    return queued(plugin, async () => { const doc = await api.getPluginDoc(plugin, key); return doc ? (doc.value as T) : fallback; });
  },
  set(plugin: string, key: string, value: unknown): Promise<void> {
    return queued(plugin, async () => { await api.setPluginDoc(plugin, key, value); });
  },
  remove(plugin: string, key: string): Promise<void> {
    return queued(plugin, async () => { try { await api.deletePluginDoc(plugin, key); } catch (e) { if (!(e instanceof ApiError && e.status === 404)) throw e; } });
  },
  list(plugin: string): Promise<string[]> {
    return queued(plugin, async () => (await api.listPluginDocs(plugin)).docs.map((d) => d.key));
  },
  /** Every document with its value, in one call (a store the plugin reads whole). */
  all<T = unknown>(plugin: string): Promise<{ key: string; value: T }[]> {
    return queued(plugin, async () => (await api.listPluginDocsWithValues(plugin)).docs.map((d) => ({ key: d.key, value: d.value as T })));
  },
};
const settings = {
  async get<T = unknown>(plugin: string, fallback: T): Promise<T> {
    const r = await api.getPluginSettings(plugin);
    return r.value === null || r.value === undefined ? fallback : (r.value as T);
  },
  async set(plugin: string, value: unknown): Promise<void> { await api.setPluginSettings(plugin, value); },
};

/**
 * The daemon's event stream for plugins (spec section 2.2): `thread:*` events (prompts, tools,
 * turns, status, spawns), `plugin:*` events, and every other server event. The host feeds it.
 */
type EventHandler = (e: ServerEvent) => void;
const eventListeners = new Map<string, Set<EventHandler>>();
export function dispatchServerEvent(e: ServerEvent): void {
  for (const key of [e.type, '*']) for (const fn of eventListeners.get(key) ?? []) { try { fn(e); } catch (err) { console.error('[plugin event handler]', err); } }
}
export const events = {
  /** Subscribe to one type, several, or '*'; returns the unsubscribe. */
  on(type: string | string[], handler: EventHandler): () => void {
    const keys = Array.isArray(type) ? type : [type];
    for (const k of keys) { const set = eventListeners.get(k) ?? new Set(); set.add(handler); eventListeners.set(k, set); }
    return () => { for (const k of keys) { const set = eventListeners.get(k); set?.delete(handler); if (set && set.size === 0) eventListeners.delete(k); } };
  },
};

/** One model call through the daemon (spec section 3.4); needs the plugin's `model:assist` permission. */
function assist(plugin: string, req: PluginAssistRequest) {
  return api.pluginAssist(plugin, req);
}

/** Listeners for `plugin:data` events, keyed `plugin/key`; the host feeds them (host.ts). */
const docListeners = new Map<string, Set<() => void>>();
export function notifyDocChanged(plugin: string, key: string): void {
  for (const fn of docListeners.get(`${plugin}/${key}`) ?? []) fn();
}

/** What `useDocOf` reads and writes through: version 1 passes its storage, version 2 its bound docs. */
export interface DocAccess { get<T>(key: string, fallback: T): Promise<T>; set(key: string, value: unknown): Promise<void> }

/** A document as React state: `[value, setValue, loading]`; refreshes when another client writes it. */
export function useDocOf<T = unknown>(access: DocAccess, plugin: string, key: string, fallback: T): [T, (next: T) => Promise<void>, boolean] {
  const [value, setValue] = useState<T>(fallback);
  const [loading, setLoading] = useState(true);
  const fallbackRef = useRef(fallback);
  const accessRef = useRef(access);
  accessRef.current = access;
  const load = useCallback(async () => {
    try { setValue(await accessRef.current.get(key, fallbackRef.current)); } catch { /* keep what is shown */ }
    setLoading(false);
  }, [plugin, key]); // eslint-disable-line react-hooks/exhaustive-deps -- `plugin` names whose document this is
  useEffect(() => {
    void load();
    const id = `${plugin}/${key}`;
    const set = docListeners.get(id) ?? new Set();
    set.add(load); docListeners.set(id, set);
    return () => { set.delete(load); if (set.size === 0) docListeners.delete(id); };
  }, [plugin, key, load]);
  const update = useCallback(async (next: T) => { setValue(next); await accessRef.current.set(key, next); }, [key]);
  return [value, update, loading];
}
function useDoc<T = unknown>(plugin: string, key: string, fallback: T): [T, (next: T) => Promise<void>, boolean] {
  const access = useMemo<DocAccess>(() => ({ get: (k, f) => storage.get(plugin, k, f), set: (k, v) => storage.set(plugin, k, v) }), [plugin]);
  return useDocOf(access, plugin, key, fallback);
}

/** A fetch that names the plugin, so the daemon's log can say which plugin called what. */
function pluginFetch(plugin: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('X-Dispatch-Plugin', plugin);
  return fetch(apiPath(path), { ...init, headers });
}

/**
 * The deprecated members (W3-F): one console warning for each plugin and member, on the first read.
 * A reload hands the bundle a new object, so the memory is here, not on the object.
 */
const warned = new Set<string>();
const REPLACEMENT: Record<'api' | 'stores', string> = {
  api: 'Use the bound members of SDK version 2: sdk.docs, sdk.settings, sdk.worker.fetch, sdk.assist, sdk.model, sdk.files and sdk.plugin.',
  stores: 'Use sdk.threads and sdk.projects (plain data, with onChange), sdk.hooks.useThreads and sdk.hooks.useProjects, and sdk.navigate, of SDK version 2.',
};
function warnDeprecated(pluginId: string, member: 'api' | 'stores'): void {
  const id = `${pluginId}|${member}`;
  if (warned.has(id)) return;
  warned.add(id);
  const who = pluginId ? `The plugin "${pluginId}"` : 'A plugin (through window.dispatch)';
  console.warn(`[dispatch] ${who} uses sdk.${member}, which is deprecated and goes away in the next major version of Dispatch. ${REPLACEMENT[member]} Set "sdk": 2 in plugin.json to get that object. See docs/plugins.md, "Moving a plugin to SDK version 2".`);
}
/** Test seam: forget which plugins were warned. */
export function __resetDeprecationWarningsForTest(): void { warned.clear(); }

/** The controls and styles both SDK versions hand out. */
export const uiKit = { Modal, Markdown, FileViewer, Toggle, FilterBar, Select, MultiSelect, Segmented, SettingsGroup, SettingsRow, styles: { sectionLabel, row, item, ghostBtn, solidBtn, chip, fieldInput } };

/** The app actions both SDK versions hand out (the W2-F wrappers: a plugin never touches the UI store). */
export const appActions = {
  setView: (key: string): void => useUI.getState().setView(key as never),
  openThread: (projectId: string, terminalId: string): Promise<void> => openThreadInPlace(projectId, terminalId),
  openSettings: (sectionKey: string): void => useUI.getState().requestSettings(sectionKey),
  setBadge: (viewKey: string, n: number): void => usePluginRegistry.getState().setBadge(viewKey, n),
  openSchedule: (p: { projectId?: string; prompt: string; cron?: string; label?: string }): void => usePluginDialogs.getState().openSchedule(p),
  openNewThreads: (p: { projectId?: string; prompts: string[] }): void => usePluginDialogs.getState().openNewThreads(p),
  createSkill: (draft: { id?: string; name: string; description?: string; body: string; projects?: string[]; projectId?: string }): Promise<{ id: string } | null> => usePluginDialogs.getState().openSkill(draft),
};

export interface DispatchSdk {
  version: string;
  /** The plugin's own id (plugin.json), as the host hands it to `activate`; use it for register, storage, settings and fetch. Empty on the shared window.dispatch. */
  id: string;
  React: typeof React;
  h: typeof React.createElement;
  Fragment: typeof React.Fragment;
  hooks: {
    useState: typeof useState; useEffect: typeof useEffect; useMemo: typeof useMemo; useCallback: typeof useCallback; useRef: typeof useRef;
    useIsMobile: typeof useIsMobile; useContributions: typeof useContributions;
    useDoc: typeof useDoc;
    /** Read a store with a selector; memoise an array-returning selector yourself, or use useContributions. */
    useStore: <S, T>(store: UseBoundStore<StoreApi<S>>, selector: (s: S) => T) => T;
  };
  zustand: { create: typeof create };
  /** @deprecated Goes away in the next major version. Use `threads`, `projects`, `hooks.useThreads`, `hooks.useProjects` and `navigate` of SDK version 2 (facade.ts). */
  stores: { useUI: typeof useUI; useProjects: typeof useProjects; useTabs: typeof useTabs; useUpdate: typeof useUpdate; useThreadStatus: typeof useThreadStatus };
  actions: {
    setView: (key: string) => void;
    openThread: (projectId: string, terminalId: string) => Promise<void>;
    openSettings: (sectionKey: string) => void;
    /** An unseen count on a view (`plugin:<id>:<view>`); 0 clears it. */
    setBadge: (viewKey: string, n: number) => void;
    /** The new-automation dialog with the prompt (and cron, name) filled; nothing is saved until the person saves. No project = the open one. */
    openSchedule: (p: { projectId?: string; prompt: string; cron?: string; label?: string }) => void;
    /** The new-thread dialog listing one thread per prompt; nothing starts until the person presses Start. No project = the open one. */
    openNewThreads: (p: { projectId?: string; prompts: string[] }) => void;
    /** Opens the skill review sheet with a draft; resolves with the created skill's id on Create, null on Cancel. */
    createSkill: (draft: { id?: string; name: string; description?: string; body: string; projects?: string[]; projectId?: string }) => Promise<{ id: string } | null>;
  };
  /** @deprecated Goes away in the next major version. Use the bound members of SDK version 2 (facade.ts). */
  api: typeof api;
  ui: typeof uiKit;
  icons: Record<string, Icon>;
  storage: typeof storage;
  settings: typeof settings;
  events: typeof events;
  assist: typeof assist;
  /** fetch with the plugin named in a header. */
  fetch: typeof pluginFetch;
  /** The plugin's worker, through the daemon's proxy: `worker.fetch(plugin, 'jobs/run', { method: 'POST' })` → `/api/plugins/<id>/worker/jobs/run`. */
  worker: { fetch: (plugin: string, path: string, init?: RequestInit) => Promise<Response> };
  /** An app-root-relative path (`/api/...`, `/plugins/...`) as the browser must request it. */
  apiPath: typeof apiPath;
  hint: (msg: string) => void;
  copyText: (text: string) => Promise<void>;
  register: (plugin: string, c: Contributions) => void;
  unregister: (plugin: string) => void;
}

/**
 * The version 1 object. `pluginId` only names the plugin in the deprecation warning; the shared
 * `window.dispatch` has none. `api` and `stores` are getters, so building or copying the rest of the
 * object warns nobody.
 */
export function buildSdk(pluginId = ''): DispatchSdk {
  const stores = { useUI, useProjects, useTabs, useUpdate, useThreadStatus };
  return {
    version: SDK_VERSION,
    id: '',
    React,
    h: React.createElement,
    Fragment: React.Fragment,
    hooks: {
      useState, useEffect, useMemo, useCallback, useRef, useIsMobile, useContributions, useDoc,
      useStore: (store, selector) => store(selector),
    },
    zustand: { create },
    get stores() { warnDeprecated(pluginId, 'stores'); return stores; },
    actions: { ...appActions },
    get api() { warnDeprecated(pluginId, 'api'); return api; },
    ui: uiKit,
    icons: ICONS,
    storage,
    settings,
    events,
    assist,
    fetch: pluginFetch,
    worker: { fetch: (plugin, p, init) => pluginFetch(plugin, `/api/plugins/${encodeURIComponent(plugin)}/worker/${p.replace(/^\/+/, '')}`, init) },
    apiPath,
    hint: (msg) => useHint.getState().show(msg),
    copyText,
    register: (plugin, c) => usePluginRegistry.getState().register(plugin, c),
    unregister: (plugin) => usePluginRegistry.getState().unregister(plugin),
  };
}

/**
 * The version 1 object for one plugin (the compatibility shim, W3-F): what `activate` gets when the
 * manifest does not say `sdk: 2`. Everything a version 1 bundle used is still there. The id the
 * bundle passes must be its own: a call that names another plugin is refused before any request, as
 * `register` always was (spec section 14). Listeners the bundle adds are dropped with its
 * contributions, so a reload never leaves a second copy behind.
 */
export function createLegacySdk(pluginId: string): DispatchSdk {
  const d = buildSdk(pluginId);
  const refusal = (what: string, given: string): Error => new Error(`The plugin "${pluginId}" called ${what} with the id "${given}". A plugin uses its own id.`);
  /** `fn(plugin, ...)` only when `plugin` is this plugin; the promise rejects otherwise. */
  const own = <A extends unknown[], R>(what: string, fn: (plugin: string, ...rest: A) => Promise<R>) =>
    (plugin: string, ...rest: A): Promise<R> => (plugin === pluginId ? fn(plugin, ...rest) : Promise.reject(refusal(what, plugin)));
  const base = { storage: d.storage, settings: d.settings, assist: d.assist, fetch: d.fetch, worker: d.worker, useDoc: d.hooks.useDoc, events: d.events };
  d.id = pluginId;
  d.storage = {
    get: own('storage.get', base.storage.get) as typeof storage.get,
    set: own('storage.set', base.storage.set),
    remove: own('storage.remove', base.storage.remove),
    list: own('storage.list', base.storage.list),
    all: own('storage.all', base.storage.all) as typeof storage.all,
  };
  d.settings = { get: own('settings.get', base.settings.get) as typeof settings.get, set: own('settings.set', base.settings.set) };
  d.assist = own('assist', base.assist);
  d.fetch = own('fetch', base.fetch);
  d.worker = { fetch: own('worker.fetch', base.worker.fetch) };
  d.hooks = { ...d.hooks, useDoc: ((plugin: string, key: string, fallback: unknown) => { if (plugin !== pluginId) throw refusal('hooks.useDoc', plugin); return base.useDoc(plugin, key, fallback); }) as typeof useDoc };
  d.events = { on: (type, handler) => { const off = base.events.on(type, handler); usePluginRegistry.getState().addCleanup(pluginId, off); return off; } };
  d.register = (id, c) => {
    if (id !== pluginId) throw new Error(`The bundle registered as "${id}" but plugin.json says "${pluginId}". A plugin registers under its own id.`);
    usePluginRegistry.getState().register(id, c);
  };
  d.unregister = (id) => { if (id === pluginId) usePluginRegistry.getState().unregister(id); else console.warn(`[plugin ${pluginId}] tried to unregister "${id}"; ignored`); };
  return d;
}

declare global { interface Window { dispatch?: DispatchSdk } }

/** The one SDK object; built on first use and kept for the life of the page. */
export function installSdk(): DispatchSdk {
  if (!window.dispatch) window.dispatch = buildSdk();
  return window.dispatch;
}
