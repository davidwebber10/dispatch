/**
 * The Dispatch plugin SDK (docs/plugins.md). A plugin's `web.js` exports `activate(d)`; `d` is
 * this object. There is no runtime in this package: the app hands the real SDK to the bundle.
 * `declare const d: import('@dispatchd/sdk').DispatchSdk` is enough to type a plugin.
 */
import type * as React from 'react';

export type SdkVersion = 1;

// ── the app's data a plugin reads ────────────────────────────────────────────────────────────
export interface Session { id: string; name: string; workingDir: string; provider: string; status: string }
export interface Terminal { id: string; sessionId: string; type: string; label: string; status?: string }
export interface PluginRow { id: string; name: string; version: string; description?: string; enabled: boolean; bundled?: boolean; install?: { marketplace: string; version: string } | null; permissions?: string[] }
export interface PluginDoc { key: string; value: unknown; writer: { terminalId: string; sessionId: string; label: string | null } | null; updatedAt: string; bytes: number }

/** A zustand store as the app exposes it: call it with a selector inside a component; `getState` elsewhere. */
export interface Store<S> {
  <T>(selector: (s: S) => T): T;
  getState(): S;
  subscribe(listener: (s: S, prev: S) => void): () => void;
}

// ── contributions ───────────────────────────────────────────────────────────────────────────
export interface ComposerCtx {
  surface: 'thread' | 'terminal' | 'chat' | 'unknown';
  terminalId?: string;
  sessionId?: string;
  value: string;
  insert(text: string): void;
  set(text: string): void;
}
export interface Contributions {
  views?: { id: string; label: string; icon?: string; Component: React.ComponentType }[];
  settings?: { id: string; label: string; blurb?: string; icon?: string; Component: React.ComponentType<{ onDone?: () => void }> }[];
  threadMenu?: { id: string; label: string; when?(ctx: { tab: Terminal }): boolean; onPick(ctx: { tab: Terminal }): void }[];
  projectMenu?: { id: string; label: string; when?(ctx: { session: Session }): boolean; onPick(ctx: { session: Session }): void }[];
  composerActions?: { id: string; label: string; icon?: string; when?(ctx: ComposerCtx): boolean; onClick(ctx: ComposerCtx): void }[];
  /** `composer.before`, `project.header.actions`, `thread.header.actions`, `app.overlay`; the slot's props are the component's props. */
  slots?: { id: string; slot: string; priority?: number; Component: React.ComponentType<any> }[];
  commands?: { id: string; label: string; run(): void }[];
  /**
   * Tabs in the desktop right column, after Details and Files (higher `priority` first, then plugin
   * id); on a phone, rows in the thread's ⋯ menu that open a full-height sheet. The selected tab's
   * key is `plugin:<pluginId>:<id>`. `icon` is a name from `icons` or an icon component.
   */
  inspectorTabs?: {
    id: string;
    label: string;
    icon?: string | React.ComponentType<{ size?: number | string }>;
    priority?: number;
    Component: React.ComponentType<{ terminalId: string | null; sessionId: string | null }>;
  }[];
}

// ── the daemon's events ─────────────────────────────────────────────────────────────────────
export interface ThreadEventBase { terminalId: string; sessionId: string; harness: string; at: string }
export type ThreadEvent =
  | (ThreadEventBase & { type: 'thread:spawned'; toolsAvailable: string[] })
  | (ThreadEventBase & { type: 'thread:prompt'; source: 'user' | 'coordinator' | 'thread' | 'daemon'; text?: string; textLength: number })
  | (ThreadEventBase & { type: 'thread:tool'; tool: string; input?: unknown; inputLength: number })
  | (ThreadEventBase & { type: 'thread:turn'; ms: number | null; inputTokens: number | null; outputTokens: number | null; costUsd: number | null; outcome: string; declared?: boolean; summary?: string; partial?: boolean })
  | (ThreadEventBase & { type: 'thread:status'; state: 'done' | 'needs_you' | 'blocked'; summary: string; ask?: string; blocker?: string });
export type PluginEvent =
  | { type: 'plugin:data'; id: string; key: string; deleted?: boolean }
  | { type: 'plugin:settings'; id: string }
  | { type: 'plugin:changed'; id: string }
  | { type: 'plugin:updated'; id: string; from: string; to: string }
  | { type: 'plugin:updates' };
/** Every server event reaches `events.on`; the ones above are typed, the rest carry `type` and whatever the daemon sent. */
export type ServerEvent = ThreadEvent | PluginEvent | { type: string; [key: string]: unknown };

// ── the SDK ─────────────────────────────────────────────────────────────────────────────────
/** One choice in a FilterBar facet. */
export interface FilterOption {
  value: string;
  label: string;
  /** A quiet second word on the row. */
  note?: string;
  /** How many items this choice leaves. Omitted, no count shows. */
  count?: number;
}

/** One filter in a FilterBar: a section in the panel and, while on, a pill. */
export interface FilterFacet {
  id: string;
  /** The section heading and the pill prefix: "Project". */
  title: string;
  /** The current pick; null is no filter (the All row). */
  value: string | null;
  options: FilterOption[];
  onChange(value: string | null): void;
  /** The All row's label. Default "All". */
  allLabel?: string;
  allCount?: number;
  /** `segmented`: a row of radio buttons, All last, for two or three choices. Default `list`. */
  display?: 'list' | 'segmented';
  /** A search box inside the section. Default: on past 8 options. */
  searchable?: boolean;
  /** Whether the section starts unfolded. Default: when it has a pick, or when there are 2 facets or fewer. */
  defaultOpen?: boolean;
}

export interface FilterBarProps {
  facets: FilterFacet[];
  /** The search field; without `onQueryChange` there is none. */
  query?: string;
  onQueryChange?(query: string): void;
  /** The search placeholder, also its accessible name. */
  placeholder?: string;
  /** Takes the search's place left of the button. */
  leading?: React.ReactNode;
  /** Called by Clear after every facet is reset. */
  onClear?(): void;
  /** The panel footer's close button. Default "Done". */
  doneLabel?: string;
  /** Default by screen width: `popover` on the desktop, `sheet` on the phone. */
  variant?: 'popover' | 'sheet';
  /** Default by screen width: `md` on the desktop, `lg` on the phone. */
  size?: 'md' | 'lg';
  style?: React.CSSProperties;
  rowStyle?: React.CSSProperties;
  pillsStyle?: React.CSSProperties;
  rowTestId?: string;
}

export interface SelectProps {
  value: string;
  options: { value: string; label: string; hint?: string }[];
  onChange(value: string): void;
  /** The accessible name; or give an `id` and a `<label htmlFor>`. */
  ariaLabel?: string;
  id?: string;
  /** The search box over the list. Default: on past 8 options. */
  searchable?: boolean;
  /** The trigger text while no option matches `value`. */
  placeholder?: string;
  /** Default by screen width: `md` on the desktop, `lg` on the phone. */
  size?: 'md' | 'lg';
  style?: React.CSSProperties;
  disabled?: boolean;
}

export interface DispatchSdk {
  version: string;
  /** This plugin's id, as plugin.json names it: use it for register, storage, settings and fetch. */
  id: string;
  React: typeof React;
  h: typeof React.createElement;
  Fragment: typeof React.Fragment;
  hooks: {
    useState: typeof React.useState; useEffect: typeof React.useEffect; useMemo: typeof React.useMemo; useCallback: typeof React.useCallback; useRef: typeof React.useRef;
    useIsMobile(): boolean;
    /** A document in this plugin's storage: `[value, set, loaded]`, refreshed when the daemon says it changed. */
    useDoc<T>(plugin: string, key: string, fallback: T): [T, (next: T) => Promise<void>, boolean];
    useStore<S, T>(store: Store<S>, selector: (s: S) => T): T;
  };
  zustand: { create: <S>(init: (set: (partial: Partial<S> | ((s: S) => Partial<S>)) => void, get: () => S) => S) => Store<S> };
  /** The app's stores, typed by the fields a plugin reads; each has more. */
  stores: {
    useUI: Store<{ view: string; setView(view: string): void }>;
    useProjects: Store<{ sessions: Session[] }>;
    useTabs: Store<{ byProject: Record<string, Terminal[]> }>;
    useUpdate: Store<object>;
    useThreadStatus: Store<object>;
  };
  actions: {
    setView(key: string): void;
    openThread(projectId: string, terminalId: string): Promise<void>;
    openSettings(sectionKey: string): void;
    /** An unseen count on one of this plugin's views (`plugin:<id>:<view>`); 0 clears it. */
    setBadge(viewKey: string, n: number): void;
    /**
     * Opens the new-automation dialog with the prompt (and the cron and name) filled. Nothing is
     * saved until the person presses Save. No `projectId` = the open project.
     */
    openSchedule(p: { projectId?: string; prompt: string; cron?: string; label?: string }): void;
    /**
     * Opens the new-thread dialog listing one thread per prompt. Nothing starts until the person
     * presses Start; then each thread gets its prompt as its first message.
     */
    openNewThreads(p: { projectId?: string; prompts: string[] }): void;
    /**
     * Opens the review sheet for a drafted skill (name, id, description, SKILL.md body, and which
     * projects get it, all editable). Only its Create writes and enables the skill
     * (`POST /api/skills`); resolves with `{ id }`, or null on Cancel.
     */
    createSkill(draft: { id?: string; name: string; description?: string; body: string; projects?: string[]; projectId?: string }): Promise<{ id: string } | null>;
  };
  /** The app's API client. The methods a plugin uses most; the object has more. */
  api: {
    listSessions(): Promise<Session[]>;
    listTerminals(sessionId: string): Promise<Terminal[]>;
    listPlugins(): Promise<{ plugins: PluginRow[] }>;
    [method: string]: (...args: any[]) => any;
  };
  ui: {
    Modal: React.ComponentType<{ open: boolean; onClose(): void; title?: string; sheet?: boolean; maxWidth?: number; children: React.ReactNode }>;
    Markdown: React.ComponentType<{ source: string }>;
    FileViewer: React.ComponentType<{ files: { src: string; name: string; mime: string; size?: number; loadText?(): Promise<string> }[]; index?: number; onClose(): void; label?: string }>;
    Toggle: React.ComponentType<{ on: boolean; onClick(): void; label?: string }>;
    /**
     * The app's filter control: a search field with a Filters button to its right. The button
     * opens a panel (a popover on the desktop, a bottom sheet on the phone) with one section per
     * facet, each a single-select list (with counts when given, and a search box past 8 options).
     * Active filters show as removable pills under the row; Clear resets them all.
     */
    FilterBar: React.ComponentType<FilterBarProps>;
    /** The app's dropdown for form fields (a native `<select>` is not used anywhere). Search box past 8 options. */
    Select: React.ComponentType<SelectProps>;
    styles: { sectionLabel: React.CSSProperties; row: React.CSSProperties; item: React.CSSProperties; ghostBtn: React.CSSProperties; solidBtn(on: boolean): React.CSSProperties; chip: React.CSSProperties; fieldInput: React.CSSProperties };
  };
  /** Icon components by name (`eye`, `star`, `sparkle`, `sun`, …); the same names `contributes.views[].icon` takes. */
  icons: Record<string, React.ComponentType<any>>;
  /** Documents in this plugin's storage on the daemon (`threads:*-storage` lets threads reach them). */
  storage: {
    get<T>(plugin: string, key: string, fallback: T): Promise<T>;
    set(plugin: string, key: string, value: unknown): Promise<void>;
    remove(plugin: string, key: string): Promise<void>;
    list(plugin: string): Promise<string[]>;
    all<T = unknown>(plugin: string): Promise<{ key: string; value: T }[]>;
  };
  settings: { get<T>(plugin: string, fallback: T): Promise<T>; set(plugin: string, value: unknown): Promise<void> };
  /** The daemon's event stream; listeners are dropped when the plugin reloads. */
  events: { on(type: string | string[], handler: (e: ServerEvent) => void): () => void };
  /**
   * One model call through the daemon (`model:assist`). `harness` runs one harness only (no
   * fallback); `auto` runs on the account with the most room; absent = Claude, then OpenRouter.
   * `model` is that harness's model id.
   */
  assist(plugin: string, req: {
    system?: string;
    messages: { role: 'user' | 'assistant'; content: string }[];
    maxTokens?: number;
    harness?: 'claude' | 'codex' | 'openrouter' | 'auto';
    model?: string;
    accountId?: string;
  }): Promise<{
    text: string;
    usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheCreateTokens?: number };
    ms: number;
    model: string;
    harness?: 'claude' | 'codex' | 'openrouter';
    accountId?: string | null;
    costUsd?: number | null;
  }>;
  /** fetch with the plugin named in a header; `path` is app-root-relative (`/api/...`, `/plugins/...`). */
  fetch(plugin: string, path: string, init?: RequestInit): Promise<Response>;
  /** This plugin's worker through the daemon's proxy. */
  worker: { fetch(plugin: string, path: string, init?: RequestInit): Promise<Response> };
  apiPath(path: string): string;
  hint(message: string): void;
  copyText(text: string): Promise<void>;
  register(plugin: string, c: Contributions): void;
  unregister(plugin: string): void;
}

declare global { interface Window { dispatch?: DispatchSdk } }
