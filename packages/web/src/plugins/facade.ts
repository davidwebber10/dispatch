import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import type { Icon } from '@phosphor-icons/react';
import { ApiError, type PluginAssistRequest, type PluginAssistResult, type PluginAssistShare, type PluginAssistUsage } from '../api/client';
import type { ServerEvent } from '../api/events-socket';
import type { Session, Terminal } from '../api/types';
import { apiPath } from '../lib/basePath';
import type { Route } from '../lib/routes';
import { reloadForSignIn } from '../lib/signInReload';
import { copyText } from '../lib/clipboard';
import { useProjects } from '../stores/projects';
import { useTabs } from '../stores/tabs';
import { useThreadStatus } from '../stores/threadStatus';
import { useNavigation } from '../stores/navigation';
import { useHint } from '../stores/hint';
import { useIsMobile } from '../hooks/useIsMobile';
import { usePluginRegistry, useContributions, viewKey, type Contributions } from './registry';
import { ICONS, appActions, events as serverEvents, queued, uiKit, useDocOf, type DocAccess } from './sdk';

/**
 * The narrow plugin SDK, version 2 (engineering program 2026-11-09, W3-F): the object `activate`
 * gets when the plugin's manifest says `sdk: 2`.
 *
 * `createPluginSdk(pluginId)` binds the id. No function of the object takes a plugin id from the
 * caller, so a bundle cannot name another plugin's documents, settings, worker, files or budget.
 * Every request the object makes carries `X-Dispatch-Plugin-Bound: <id>`; the daemon refuses a
 * request whose header names one plugin and whose path names another (routes/plugins.ts).
 *
 * The object gives no API client and no store. The app's threads and projects come as plain data
 * (`ThreadInfo`, `ProjectInfo`, `ThreadStatusInfo`): a store can change its shape without a change
 * for a plugin.
 *
 * This is a guard against one plugin acting as another through the SDK. It is not a sandbox: a
 * bundle is code in the owner's page.
 */

/** A thread, as a plugin sees it. Plain data: a copy, not the app's row. */
export interface ThreadInfo {
  id: string;
  /** The project the thread belongs to. */
  projectId: string;
  label: string;
  /** The harness: `claude-code`, `codex`, `shell`, … */
  kind: string;
  /** The stored coarse status: `working`, `needs_input`, `waiting`, `error`, … */
  status: string;
  archived: boolean;
  createdAt: string;
  lastActivityAt: string | null;
}
/** A thread's live status. */
export interface ThreadStatusInfo {
  /** The coarse status; the live one when the daemon sent one since the page loaded, else the stored one. */
  status: string;
  /** The finer state (`starting`, `working`, `needs_input`, `idle`, `done`, `error`); null when no live event carried it. */
  state: string | null;
  /** What the thread is doing, in words ("Running: npm test"); null when not known. */
  activity: string | null;
  /** Epoch ms since which a working thread sent no output; null when the thread is not flagged. */
  stalledSince: number | null;
}
/** A project, as a plugin sees it. */
export interface ProjectInfo { id: string; name: string; workingDir: string; archived: boolean }

export interface PluginBudget { percentWeekly: number | null; usdWeekly: number | null }

export interface DispatchSdkV2 {
  readonly version: 2;
  /** This plugin's id, as plugin.json names it. Read-only: the object is bound to it. */
  readonly id: string;
  React: typeof React;
  h: typeof React.createElement;
  Fragment: typeof React.Fragment;
  hooks: {
    useState: typeof useState; useEffect: typeof useEffect; useMemo: typeof useMemo; useCallback: typeof useCallback; useRef: typeof useRef;
    useIsMobile: typeof useIsMobile;
    useContributions: typeof useContributions;
    /** A document of this plugin as React state: `[value, set, loading]`; refreshed when the daemon says it changed. */
    useDoc: <T = unknown>(key: string, fallback: T) => [T, (next: T) => Promise<void>, boolean];
    /** The projects, as React state. The array is the same object until the list changes. */
    useProjects: () => ProjectInfo[];
    /** The loaded threads of every project, as React state. */
    useThreads: () => ThreadInfo[];
  };
  zustand: { create: typeof create };
  /** This plugin's documents on the daemon. */
  docs: {
    get: <T = unknown>(key: string, fallback: T) => Promise<T>;
    set: (key: string, value: unknown) => Promise<void>;
    delete: (key: string) => Promise<void>;
    keys: () => Promise<string[]>;
    entries: <T = unknown>() => Promise<{ key: string; value: T }[]>;
  };
  /** This plugin's settings: one JSON value. `get` gives the fallback (null when none) while nothing is saved. */
  settings: { get: <T = unknown>(fallback?: T) => Promise<T>; set: (value: unknown) => Promise<void> };
  threads: {
    /** The threads of every project whose list the app has loaded. */
    list: () => ThreadInfo[];
    get: (id: string) => ThreadInfo | null;
    status: (id: string) => ThreadStatusInfo | null;
    /** Ask the app to read the thread list of one project (of every project when no id is given) and give it back. */
    load: (projectId?: string) => Promise<ThreadInfo[]>;
    /** Called when a thread is added, removed or changed, or a status changes. Returns the function that stops it. */
    onChange: (fn: () => void) => () => void;
  };
  projects: {
    list: () => ProjectInfo[];
    /** The open project. */
    active: () => ProjectInfo | null;
    onChange: (fn: () => void) => () => void;
  };
  /** Go to a screen: a thread, a project, a settings section, one of this plugin's views (`{ view: 'plugin:<id>:<view>' }`). */
  navigate: (route: Route) => void;
  actions: {
    setView: (key: string) => void;
    openThread: (projectId: string, terminalId: string) => Promise<void>;
    openSettings: (sectionKey: string) => void;
    /** An unseen count on one of this plugin's views: the view's id, or its key `plugin:<id>:<view>`. 0 clears it. */
    setBadge: (view: string, n: number) => void;
    openSchedule: (p: { projectId?: string; prompt: string; cron?: string; label?: string }) => void;
    openNewThreads: (p: { projectId?: string; prompts: string[] }) => void;
    createSkill: (draft: { id?: string; name: string; description?: string; body: string; projects?: string[]; projectId?: string }) => Promise<{ id: string } | null>;
  };
  ui: typeof uiKit & {
    /** A short line at the bottom of the screen, gone after a few seconds. */
    hint: (text: string) => void;
    copyText: (text: string) => Promise<void>;
  };
  icons: Record<string, Icon>;
  /** The daemon's event stream; a listener is dropped when the plugin reloads. */
  events: { on: (type: string | string[], fn: (e: ServerEvent) => void) => () => void };
  /** One model call through the daemon (`model:assist`). */
  assist: (req: PluginAssistRequest) => Promise<PluginAssistResult>;
  /** What this plugin's model calls cost, and its budget. */
  model: {
    usage: (range?: { from?: string; to?: string }) => Promise<PluginAssistUsage>;
    share: (q?: { accountId?: string; harness?: 'claude' | 'codex' }) => Promise<{ fiveHour: PluginAssistShare | null; sevenDay: PluginAssistShare | null }>;
    budget: () => Promise<PluginBudget>;
    setBudget: (budget: Partial<PluginBudget>) => Promise<PluginBudget>;
  };
  /** This plugin itself. */
  plugin: {
    /** Turn this plugin off, as the switch on the Plugins page does. */
    disable: () => Promise<void>;
  };
  /** The file references threads registered with this plugin (`POST /api/plugins/<id>/files`). */
  files: {
    /** The address of a file's bytes, for an `<img src>` or the FileViewer. */
    url: (fileId: string) => string;
    remove: (fileId: string) => Promise<void>;
  };
  /** This plugin's worker, through the daemon's proxy: `worker.fetch('jobs/run', { method: 'POST' })`. */
  worker: { fetch: (path: string, init?: RequestInit) => Promise<Response> };
  /** An app-root-relative path (`/api/...`, `/plugins/...`) as the browser must request it. */
  url: (path: string) => string;
  /** Replace this plugin's contributions. */
  register: (c: Contributions) => void;
}

/** The members of the version 2 object. `sdk-declaration.test.ts` holds `packages/sdk/index.d.ts` to the same list. */
export const SDK_V2_KEYS = [
  'version', 'id', 'React', 'h', 'Fragment', 'hooks', 'zustand', 'docs', 'settings', 'threads', 'projects', 'navigate', 'actions',
  'ui', 'icons', 'events', 'assist', 'model', 'plugin', 'files', 'worker', 'url', 'register',
] as const satisfies readonly (keyof DispatchSdkV2)[];

/** The daemon's rule for a plugin id (core plugins/manifest.ts PLUGIN_ID_RE). */
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const threadInfo = (t: Terminal): ThreadInfo => ({
  id: t.id, projectId: t.sessionId, label: t.label, kind: t.type, status: t.status,
  archived: !!t.archivedAt, createdAt: t.createdAt, lastActivityAt: t.lastActivityAt ?? null,
});
const projectInfo = (s: Session): ProjectInfo => ({ id: s.id, name: s.name, workingDir: s.workingDir, archived: !!s.archivedAt });
const allThreads = (byProject: Record<string, Terminal[]>): ThreadInfo[] => Object.values(byProject).flatMap((list) => list.map(threadInfo));
function findThread(id: string): Terminal | null {
  for (const list of Object.values(useTabs.getState().byProject)) { const t = list.find((x) => x.id === id); if (t) return t; }
  return null;
}

/**
 * A worker path that stays under the plugin's own worker: no scheme, no host, no `.` or `..`
 * segment (plain or percent-encoded), no backslash. A browser resolves `..` before it sends the
 * request, so `worker/../../other/data` would reach another plugin's routes.
 */
function ownWorkerPath(path: string): string | null {
  const [rawPath, ...query] = String(path).split('?');
  if (/^[a-z][a-z0-9+.-]*:/i.test(rawPath) || rawPath.startsWith('//') || /[\\#]/.test(rawPath)) return null;
  const clean = rawPath.replace(/^\/+/, '');
  for (const segment of clean.split('/')) {
    let decoded: string;
    try { decoded = decodeURIComponent(segment); } catch { return null; }
    if (decoded === '.' || decoded === '..' || /[\\/]/.test(decoded)) return null;
  }
  return query.length ? `${clean}?${query.join('?')}` : clean;
}

const frozen = <T extends object>(o: T): Readonly<T> => Object.freeze(o);

export function createPluginSdk(pluginId: string): DispatchSdkV2 {
  if (typeof pluginId !== 'string' || !PLUGIN_ID_RE.test(pluginId)) throw new Error(`"${String(pluginId)}" is not a plugin id.`);
  const root = `/api/plugins/${encodeURIComponent(pluginId)}`;

  /** A request under this plugin's own routes, with the bound header. `sub` starts with '/', or is empty. */
  const send = (sub: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    headers.set('X-Dispatch-Plugin', pluginId);
    headers.set('X-Dispatch-Plugin-Bound', pluginId);
    return fetch(apiPath(`${root}${sub}`), { ...init, headers });
  };
  /** The same, as JSON: throws an ApiError that carries the status and the daemon's `error` text. */
  async function call<T>(sub: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const method = init.method ?? 'GET';
    const hasBody = 'body' in init;
    const res = await send(sub, { method, ...(hasBody ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body) } : {}) });
    if (!res.ok) {
      let detail = '';
      try { const b = await res.json() as { error?: unknown }; if (typeof b?.error === 'string') detail = b.error; } catch { /* not JSON */ }
      if (res.status === 401 && detail === 'auth_required') reloadForSignIn();
      throw new ApiError(`${method} ${root}${sub} failed: ${res.status}${detail ? ` — ${detail}` : ''}`, res.status);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
  const missing = (e: unknown): boolean => e instanceof ApiError && e.status === 404;
  const doc = (key: string): string => `/data/${encodeURIComponent(String(key))}`;
  const query = (q: Record<string, string | undefined>): string => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v) p.set(k, v);
    return p.toString() ? `?${p.toString()}` : '';
  };
  /** Something to undo when the plugin is unregistered or reloaded. */
  const untilUnloaded = (off: () => void): (() => void) => { usePluginRegistry.getState().addCleanup(pluginId, off); return off; };

  // Writes queue for each plugin so two sets in a row land in order; a read waits for the queued writes.
  const docs: DispatchSdkV2['docs'] = frozen({
    get: <T = unknown>(key: string, fallback: T): Promise<T> => queued(pluginId, async () => {
      try { return (await call<{ value: T }>(doc(key))).value; } catch (e) { if (missing(e)) return fallback; throw e; }
    }),
    set: (key: string, value: unknown): Promise<void> => queued(pluginId, async () => { await call(doc(key), { method: 'PUT', body: { value } }); }),
    delete: (key: string): Promise<void> => queued(pluginId, async () => { try { await call(doc(key), { method: 'DELETE' }); } catch (e) { if (!missing(e)) throw e; } }),
    keys: (): Promise<string[]> => queued(pluginId, async () => (await call<{ docs: { key: string }[] }>('/data')).docs.map((d) => d.key)),
    entries: <T = unknown>(): Promise<{ key: string; value: T }[]> =>
      queued(pluginId, async () => (await call<{ docs: { key: string; value: T }[] }>('/data?values=1')).docs.map((d) => ({ key: d.key, value: d.value }))),
  });
  const docAccess: DocAccess = { get: (key, fallback) => docs.get(key, fallback), set: (key, value) => docs.set(key, value) };

  const settings: DispatchSdkV2['settings'] = frozen({
    get: async <T = unknown>(fallback?: T): Promise<T> => {
      const r = await call<{ value: unknown }>('/settings');
      return (r.value === null || r.value === undefined ? (fallback ?? null) : r.value) as T;
    },
    set: async (value: unknown): Promise<void> => { await call('/settings', { method: 'PUT', body: { value } }); },
  });

  const threads: DispatchSdkV2['threads'] = frozen({
    list: () => allThreads(useTabs.getState().byProject),
    get: (id: string) => { const t = findThread(id); return t ? threadInfo(t) : null; },
    status: (id: string) => {
      const t = findThread(id);
      if (!t) return null;
      const s = useThreadStatus.getState();
      const live = s.byTerminal[id];
      return { status: live?.status ?? t.status, state: live?.threadStatus ?? null, activity: live?.activity ?? null, stalledSince: s.stalls[id] ?? null };
    },
    load: async (projectId?: string) => {
      const ids = projectId ? [projectId] : useProjects.getState().sessions.map((s) => s.id);
      await Promise.all(ids.map((id) => useTabs.getState().loadTabs(id).catch(() => { /* a project that is gone has no threads */ })));
      const byProject = useTabs.getState().byProject;
      return ids.flatMap((id) => (byProject[id] ?? []).map(threadInfo));
    },
    onChange: (fn: () => void) => {
      const offTabs = useTabs.subscribe((s, prev) => { if (s.byProject !== prev.byProject) fn(); });
      const offStatus = useThreadStatus.subscribe((s, prev) => { if (s.byTerminal !== prev.byTerminal || s.stalls !== prev.stalls) fn(); });
      return untilUnloaded(() => { offTabs(); offStatus(); });
    },
  });

  const projects: DispatchSdkV2['projects'] = frozen({
    list: () => useProjects.getState().sessions.map(projectInfo),
    active: () => { const s = useProjects.getState(); const p = s.sessions.find((x) => x.id === s.activeId); return p ? projectInfo(p) : null; },
    onChange: (fn: () => void) => untilUnloaded(useProjects.subscribe((s, prev) => { if (s.sessions !== prev.sessions || s.activeId !== prev.activeId) fn(); })),
  });

  const ownViewPrefix = `plugin:${pluginId}:`;
  const sdk: DispatchSdkV2 = {
    version: 2,
    id: pluginId,
    React,
    h: React.createElement,
    Fragment: React.Fragment,
    hooks: frozen({
      useState, useEffect, useMemo, useCallback, useRef, useIsMobile, useContributions,
      useDoc: <T = unknown>(key: string, fallback: T) => useDocOf<T>(docAccess, pluginId, key, fallback),
      useProjects: () => { const sessions = useProjects((s) => s.sessions); return useMemo(() => sessions.map(projectInfo), [sessions]); },
      useThreads: () => { const byProject = useTabs((s) => s.byProject); return useMemo(() => allThreads(byProject), [byProject]); },
    }),
    zustand: frozen({ create }),
    docs,
    settings,
    threads,
    projects,
    navigate: (route: Route) => useNavigation.getState().navigate(route),
    actions: frozen({
      ...appActions,
      setBadge: (view: string, n: number) => {
        if (view.startsWith('plugin:') && !view.startsWith(ownViewPrefix)) { console.warn(`[plugin ${pluginId}] tried to set a badge on "${view}"; a plugin badges its own views. Ignored.`); return; }
        appActions.setBadge(view.startsWith(ownViewPrefix) ? view : viewKey(pluginId, view), n);
      },
    }),
    ui: frozen({ ...uiKit, hint: (text: string) => useHint.getState().show(text), copyText }),
    icons: ICONS,
    events: frozen({ on: (type: string | string[], fn: (e: ServerEvent) => void) => untilUnloaded(serverEvents.on(type, fn)) }),
    assist: (req: PluginAssistRequest) => call<PluginAssistResult>('/assist', { method: 'POST', body: req }),
    model: frozen({
      usage: (range: { from?: string; to?: string } = {}) => call<PluginAssistUsage>(`/assist/usage${query({ from: range.from, to: range.to })}`),
      share: (q: { accountId?: string; harness?: 'claude' | 'codex' } = {}) =>
        call<{ fiveHour: PluginAssistShare | null; sevenDay: PluginAssistShare | null }>(`/assist/share${query({ accountId: q.accountId, harness: q.harness })}`),
      budget: () => call<PluginBudget>('/budget'),
      setBudget: (budget: Partial<PluginBudget>) => call<PluginBudget>('/budget', { method: 'PUT', body: budget }),
    }),
    plugin: frozen({ disable: async () => { await call('/disable', { method: 'POST' }); } }),
    files: frozen({
      url: (fileId: string) => apiPath(`${root}/files/${encodeURIComponent(String(fileId))}`),
      remove: async (fileId: string) => { try { await call(`/files/${encodeURIComponent(String(fileId))}`, { method: 'DELETE' }); } catch (e) { if (!missing(e)) throw e; } },
    }),
    worker: frozen({
      fetch: (path: string, init?: RequestInit): Promise<Response> => {
        const own = ownWorkerPath(path);
        if (own === null) return Promise.reject(new Error(`The plugin "${pluginId}" reaches its own worker only: "${String(path).slice(0, 120)}" is not a path under it.`));
        return send(`/worker/${own}`, init);
      },
    }),
    url: apiPath,
    register: (c: Contributions) => usePluginRegistry.getState().register(pluginId, c),
  };
  return frozen(sdk);
}
