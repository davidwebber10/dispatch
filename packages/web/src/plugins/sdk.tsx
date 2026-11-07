import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { create, type StoreApi, type UseBoundStore } from 'zustand';
import * as Icons from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
import { api, ApiError } from '../api/client';
import type { ServerEvent } from '../api/events-socket';
import { apiPath } from '../lib/basePath';
import { useUI } from '../stores/ui';
import { useProjects } from '../stores/projects';
import { useTabs } from '../stores/tabs';
import { usePreviews } from '../stores/previews';
import { useUpdate } from '../stores/update';
import { useThreadStatus } from '../stores/threadStatus';
import { useHint } from '../stores/hint';
import { useIsMobile } from '../hooks/useIsMobile';
import { Modal } from '../components/common/Modal';
import { Markdown } from '../components/Markdown';
import { FileViewer } from '../components/viewer/FileViewer';
import { copyText } from '../lib/clipboard';
import { openThreadInPlace } from '../components/endless/openThread';
import { sectionLabel, row, item, ghostBtn, solidBtn, chip, fieldInput, Toggle } from '../components/settings/ui';
import { usePluginRegistry, useContributions, type Contributions } from './registry';

/**
 * Plugins (docs/superpowers/specs/2026-11-07-plugins-design.md, section 2.2): the object a plugin's
 * bundle finds at `window.dispatch`. A bundle ships no React or zustand; it uses the app's through
 * this object, so its screens share the app's React tree, styles and stores. `register` is the
 * one write; everything else is what the app already has.
 */
export const SDK_VERSION = '1.0';

const ICONS: Record<string, Icon> = {
  puzzle: Icons.PuzzlePiece, sun: Icons.Sun, star: Icons.Star, sparkle: Icons.Sparkle, lightning: Icons.Lightning,
  calendar: Icons.Calendar, clock: Icons.Clock, note: Icons.Note, rocket: Icons.Rocket, flag: Icons.Flag, heart: Icons.Heart,
  folder: Icons.Folder, terminal: Icons.TerminalWindow, git: Icons.GitBranch, cloud: Icons.Cloud, database: Icons.Database,
  bell: Icons.Bell, chart: Icons.ChartBar, list: Icons.ListChecks, play: Icons.Play, gear: Icons.Gear, eye: Icons.Eye,
  chat: Icons.ChatCircleDots, book: Icons.BookOpen, bug: Icons.Bug, shield: Icons.ShieldCheck, globe: Icons.Globe, wrench: Icons.Wrench,
  copy: Icons.Copy, check: Icons.Check, trash: Icons.Trash, image: Icons.Image, file: Icons.FileText, pdf: Icons.FilePdf, html: Icons.FileHtml, csv: Icons.FileCsv, x: Icons.X,
};
export const pluginIcon = (name: string | undefined): Icon => (name && ICONS[name]) || Icons.PuzzlePiece;

/**
 * Per-plugin storage on the daemon (spec section 5). Writes queue per plugin so two sets in a row
 * land in order; a read waits for the queued writes of that plugin.
 */
const queues = new Map<string, Promise<unknown>>();
function queued<T>(plugin: string, work: () => Promise<T>): Promise<T> {
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
const events = {
  /** Subscribe to one type, several, or '*'; returns the unsubscribe. */
  on(type: string | string[], handler: EventHandler): () => void {
    const keys = Array.isArray(type) ? type : [type];
    for (const k of keys) { const set = eventListeners.get(k) ?? new Set(); set.add(handler); eventListeners.set(k, set); }
    return () => { for (const k of keys) { const set = eventListeners.get(k); set?.delete(handler); if (set && set.size === 0) eventListeners.delete(k); } };
  },
};

/** One model call through the daemon (spec section 3.4); needs the plugin's `model:assist` permission. */
function assist(plugin: string, req: { system?: string; messages: { role: 'user' | 'assistant'; content: string }[]; maxTokens?: number }) {
  return api.pluginAssist(plugin, req);
}

/** Listeners for `plugin:data` events, keyed `plugin/key`; the host feeds them (host.ts). */
const docListeners = new Map<string, Set<() => void>>();
export function notifyDocChanged(plugin: string, key: string): void {
  for (const fn of docListeners.get(`${plugin}/${key}`) ?? []) fn();
}

/** A document as React state: `[value, setValue, loading]`; refreshes when another client writes it. */
function useDoc<T = unknown>(plugin: string, key: string, fallback: T): [T, (next: T) => Promise<void>, boolean] {
  const [value, setValue] = useState<T>(fallback);
  const [loading, setLoading] = useState(true);
  const fallbackRef = useRef(fallback);
  const load = useCallback(async () => {
    try { setValue(await storage.get(plugin, key, fallbackRef.current)); } catch { /* keep what is shown */ }
    setLoading(false);
  }, [plugin, key]);
  useEffect(() => {
    void load();
    const id = `${plugin}/${key}`;
    const set = docListeners.get(id) ?? new Set();
    set.add(load); docListeners.set(id, set);
    return () => { set.delete(load); if (set.size === 0) docListeners.delete(id); };
  }, [plugin, key, load]);
  const update = useCallback(async (next: T) => { setValue(next); await storage.set(plugin, key, next); }, [plugin, key]);
  return [value, update, loading];
}

/** A fetch that names the plugin, so the daemon's log can say which plugin called what. */
function pluginFetch(plugin: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('X-Dispatch-Plugin', plugin);
  return fetch(apiPath(path), { ...init, headers });
}

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
  stores: { useUI: typeof useUI; useProjects: typeof useProjects; useTabs: typeof useTabs; usePreviews: typeof usePreviews; useUpdate: typeof useUpdate; useThreadStatus: typeof useThreadStatus };
  actions: { setView: (key: string) => void; openThread: (projectId: string, terminalId: string) => Promise<void>; openSettings: (sectionKey: string) => void; /** An unseen count on a view (`plugin:<id>:<view>`); 0 clears it. */ setBadge: (viewKey: string, n: number) => void };
  api: typeof api;
  ui: { Modal: typeof Modal; Markdown: typeof Markdown; FileViewer: typeof FileViewer; Toggle: typeof Toggle; styles: { sectionLabel: React.CSSProperties; row: React.CSSProperties; item: React.CSSProperties; ghostBtn: React.CSSProperties; solidBtn: typeof solidBtn; chip: React.CSSProperties; fieldInput: React.CSSProperties } };
  icons: Record<string, Icon>;
  storage: typeof storage;
  settings: typeof settings;
  events: typeof events;
  assist: typeof assist;
  /** fetch with the plugin named in a header. */
  fetch: typeof pluginFetch;
  /** An app-root-relative path (`/api/...`, `/plugins/...`) as the browser must request it. */
  apiPath: typeof apiPath;
  hint: (msg: string) => void;
  copyText: (text: string) => Promise<void>;
  register: (plugin: string, c: Contributions) => void;
  unregister: (plugin: string) => void;
}

export function buildSdk(): DispatchSdk {
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
    stores: { useUI, useProjects, useTabs, usePreviews, useUpdate, useThreadStatus },
    actions: {
      setView: (key) => useUI.getState().setView(key as never),
      openThread: (projectId, terminalId) => openThreadInPlace(projectId, terminalId),
      openSettings: (sectionKey) => useUI.getState().requestSettings(sectionKey),
      setBadge: (viewKey, n) => usePluginRegistry.getState().setBadge(viewKey, n),
    },
    api,
    ui: { Modal, Markdown, FileViewer, Toggle, styles: { sectionLabel, row, item, ghostBtn, solidBtn, chip, fieldInput } },
    icons: ICONS,
    storage,
    settings,
    events,
    assist,
    fetch: pluginFetch,
    apiPath,
    hint: (msg) => useHint.getState().show(msg),
    copyText,
    register: (plugin, c) => usePluginRegistry.getState().register(plugin, c),
    unregister: (plugin) => usePluginRegistry.getState().unregister(plugin),
  };
}

declare global { interface Window { dispatch?: DispatchSdk } }

/** The one SDK object; built on first use and kept for the life of the page. */
export function installSdk(): DispatchSdk {
  if (!window.dispatch) window.dispatch = buildSdk();
  return window.dispatch;
}
