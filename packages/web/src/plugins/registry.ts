import { useMemo } from 'react';
import { create } from 'zustand';
import type { ComponentType } from 'react';
import type { PluginRow, Session, Terminal } from '../api/types';

/**
 * Plugins (docs/superpowers/specs/2026-11-07-plugins-design.md, section 2.3): what loaded plugins
 * contribute to the app. The existing screens read these lists beside their own static ones:
 * the rail and the phone's tabs read `views`, Settings reads `settings`, the thread and project
 * menus read their items, the composer reads `composerActions`, the right column reads `inspectorTabs`, and a named `Slot` renders
 * `slots`. A plugin registers everything under its id, so a reload drops and re-adds it whole.
 */
export type { PluginRow };

export interface PluginView { plugin: string; id: string; key: string; label: string; icon?: string; Component: ComponentType }
export interface PluginSettingsSection { plugin: string; id: string; key: string; label: string; blurb?: string; icon?: string; Component: ComponentType<{ onDone?: () => void }> }
export interface ThreadMenuCtx { tab: Terminal }
export interface ProjectMenuCtx { session: Session }
export interface PluginMenuItem<C> { plugin: string; id: string; label: string; when?: (ctx: C) => boolean; onPick: (ctx: C) => void }
export interface ComposerCtx {
  /** Which composer: a Pretty thread, a CLI thread's phone composer, the Control Plane chat, or unknown. */
  surface: 'thread' | 'terminal' | 'chat' | 'unknown';
  terminalId?: string;
  sessionId?: string;
  value: string;
  /** Append text to what is typed (with a space when needed). */
  insert: (text: string) => void;
  /** Replace what is typed. */
  set: (text: string) => void;
}
export interface PluginComposerAction { plugin: string; id: string; label: string; icon?: string; when?: (ctx: ComposerCtx) => boolean; onClick: (ctx: ComposerCtx) => void }
/** A command for the ⌘K palette (and the phone's Plugins tab). */
export interface PluginCommand { plugin: string; id: string; label: string; run: () => void }
export interface PluginSlotContent { plugin: string; id: string; slot: string; priority?: number; Component: ComponentType<Record<string, unknown>> }
/** The open thread's ids, as a right-column tab gets them: null when no thread (or project) is open. */
export interface InspectorTabProps { terminalId: string | null; sessionId: string | null }
/** A tab in the desktop right column after Details and Files (a row in the phone thread's ⋯ menu). */
export interface PluginInspectorTab { plugin: string; id: string; key: string; label: string; icon?: string; priority?: number; Component: ComponentType<InspectorTabProps> }
export type PluginStatus = { state: 'loading' | 'ready' | 'error'; error?: string; version?: string; at: number };

/** What a plugin hands to `register`: the same lists, without the fields the store derives. */
export interface Contributions {
  views?: Omit<PluginView, 'plugin' | 'key'>[];
  settings?: Omit<PluginSettingsSection, 'plugin' | 'key'>[];
  threadMenu?: Omit<PluginMenuItem<ThreadMenuCtx>, 'plugin'>[];
  projectMenu?: Omit<PluginMenuItem<ProjectMenuCtx>, 'plugin'>[];
  composerActions?: Omit<PluginComposerAction, 'plugin'>[];
  slots?: Omit<PluginSlotContent, 'plugin'>[];
  commands?: Omit<PluginCommand, 'plugin'>[];
  inspectorTabs?: Omit<PluginInspectorTab, 'plugin' | 'key'>[];
}

export type ContributionKind = 'views' | 'settings' | 'threadMenu' | 'projectMenu' | 'composerActions' | 'slots' | 'commands' | 'inspectorTabs';
type Lists = {
  views: PluginView[]; settings: PluginSettingsSection[]; threadMenu: PluginMenuItem<ThreadMenuCtx>[];
  projectMenu: PluginMenuItem<ProjectMenuCtx>[]; composerActions: PluginComposerAction[]; slots: PluginSlotContent[]; commands: PluginCommand[];
  inspectorTabs: PluginInspectorTab[];
};

interface PluginRegistryState extends Lists {
  manifests: PluginRow[];
  status: Record<string, PluginStatus>;
  /** View keys the owner gave a tab of their own on the phone (at most two). */
  promoted: string[];
  /** Unseen counts per view key, set by the plugin (a count on the rail item or the promoted tab; a dot on the Plugins tab). */
  badges: Record<string, number>;
  setManifests: (m: PluginRow[]) => void;
  setStatus: (plugin: string, s: PluginStatus) => void;
  register: (plugin: string, c: Contributions) => void;
  unregister: (plugin: string) => void;
  setPromoted: (keys: string[]) => void;
  setBadge: (viewKey: string, n: number) => void;
  /** Something to undo when the plugin is unregistered or reloaded (an event listener the SDK added). */
  addCleanup: (plugin: string, fn: () => void) => void;
}

export const viewKey = (plugin: string, id: string): string => `plugin:${plugin}:${id}`;
export const settingsKey = (plugin: string, id: string): string => `plugin:${plugin}:${id}`;
export const inspectorTabKey = (plugin: string, id: string): string => `plugin:${plugin}:${id}`;
export const isPluginView = (key: string): boolean => key.startsWith('plugin:');

export const PROMOTED_MAX = 2;
const PROMOTED_KEY = 'dispatch:plugins:promoted';
const loadPromoted = (): string[] => {
  try { const v = JSON.parse(localStorage.getItem(PROMOTED_KEY) ?? '[]'); return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, PROMOTED_MAX) : []; } catch { return []; }
};

/** Per-plugin cleanups, outside the store state: functions, not data. */
const cleanups = new Map<string, (() => void)[]>();

const drop = <T extends { plugin: string }>(xs: T[], plugin: string): T[] => xs.filter((x) => x.plugin !== plugin);

export const usePluginRegistry = create<PluginRegistryState>((set, get) => ({
  manifests: [],
  status: {},
  views: [],
  settings: [],
  threadMenu: [],
  projectMenu: [],
  composerActions: [],
  slots: [],
  commands: [],
  inspectorTabs: [],
  promoted: loadPromoted(),
  badges: {},
  setManifests: (manifests) => set({ manifests }),
  setStatus: (plugin, s) => set({ status: { ...get().status, [plugin]: s } }),
  register: (plugin, c) => {
    const s = get();
    set({
      views: [...drop(s.views, plugin), ...(c.views ?? []).map((v) => ({ ...v, plugin, key: viewKey(plugin, v.id) }))],
      settings: [...drop(s.settings, plugin), ...(c.settings ?? []).map((v) => ({ ...v, plugin, key: settingsKey(plugin, v.id) }))],
      threadMenu: [...drop(s.threadMenu, plugin), ...(c.threadMenu ?? []).map((v) => ({ ...v, plugin }))],
      projectMenu: [...drop(s.projectMenu, plugin), ...(c.projectMenu ?? []).map((v) => ({ ...v, plugin }))],
      composerActions: [...drop(s.composerActions, plugin), ...(c.composerActions ?? []).map((v) => ({ ...v, plugin }))],
      slots: [...drop(s.slots, plugin), ...(c.slots ?? []).map((v) => ({ ...v, plugin }))],
      commands: [...drop(s.commands, plugin), ...(c.commands ?? []).map((v) => ({ ...v, plugin }))],
      inspectorTabs: [...drop(s.inspectorTabs, plugin), ...(c.inspectorTabs ?? []).map((v) => ({ ...v, plugin, key: inspectorTabKey(plugin, v.id) }))],
    });
  },
  unregister: (plugin) => {
    for (const fn of cleanups.get(plugin) ?? []) { try { fn(); } catch { /* a listener already gone */ } }
    cleanups.delete(plugin);
    const s = get();
    const badges = Object.fromEntries(Object.entries(s.badges).filter(([k]) => !k.startsWith(`plugin:${plugin}:`)));
    set({
      badges,
      views: drop(s.views, plugin), settings: drop(s.settings, plugin), threadMenu: drop(s.threadMenu, plugin),
      projectMenu: drop(s.projectMenu, plugin), composerActions: drop(s.composerActions, plugin), slots: drop(s.slots, plugin), commands: drop(s.commands, plugin),
      inspectorTabs: drop(s.inspectorTabs, plugin),
    });
  },
  setPromoted: (keys) => {
    const promoted = [...new Set(keys)].slice(0, PROMOTED_MAX);
    try { localStorage.setItem(PROMOTED_KEY, JSON.stringify(promoted)); } catch { /* ignore */ }
    set({ promoted });
  },
  addCleanup: (plugin, fn) => { const list = cleanups.get(plugin) ?? []; list.push(fn); cleanups.set(plugin, list); },
  setBadge: (viewKey, n) => {
    const current = get().badges[viewKey] ?? 0;
    if ((n > 0 ? Math.floor(n) : 0) === current) return;
    const badges = { ...get().badges };
    if (n > 0) badges[viewKey] = Math.floor(n); else delete badges[viewKey];
    set({ badges });
  },
}));

/** Whether any view has a badge; the phone's Plugins tab dots when an unpromoted one has. */
export const anyBadge = (s: Pick<PluginRegistryState, 'badges' | 'promoted'>, unpromotedOnly = false): boolean =>
  Object.keys(s.badges).some((k) => !unpromotedOnly || !s.promoted.includes(k));

export function useViewBadge(viewKey: string): number {
  return usePluginRegistry((s) => s.badges[viewKey] ?? 0);
}

/**
 * A plugin's contributions of one kind, memoised: a selector that filtered inside would hand
 * React a new array every call and loop the render under zustand 5.
 */
export function useContributions<K extends ContributionKind>(kind: K, filter?: (x: Lists[K][number]) => boolean): Lists[K] {
  const list = usePluginRegistry((s) => s[kind]) as Lists[K];
  return useMemo(() => (filter ? (list as Lists[K][number][]).filter(filter) : list) as Lists[K], [list, filter]);
}

export function usePluginViews(): PluginView[] {
  return usePluginRegistry((s) => s.views);
}

/** The promoted views, in the owner's order, skipping keys whose view is not loaded. */
export function usePromotedViews(): PluginView[] {
  const views = usePluginRegistry((s) => s.views);
  const promoted = usePluginRegistry((s) => s.promoted);
  return useMemo(() => promoted.map((k) => views.find((v) => v.key === k)).filter((v): v is PluginView => !!v), [views, promoted]);
}

/** The plugin view for a view key, or undefined. */
export const pluginView = (key: string): PluginView | undefined => usePluginRegistry.getState().views.find((v) => v.key === key);

/** Right-column tabs in their shown order: higher `priority` first, then plugin id, then registration order. */
export const sortInspectorTabs = (tabs: PluginInspectorTab[]): PluginInspectorTab[] =>
  [...tabs].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.plugin.localeCompare(b.plugin));

/** The plugins' right-column tabs, sorted and memoised. */
export function useInspectorTabs(): PluginInspectorTab[] {
  const tabs = usePluginRegistry((s) => s.inspectorTabs);
  return useMemo(() => sortInspectorTabs(tabs), [tabs]);
}
