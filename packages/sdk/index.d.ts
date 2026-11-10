/**
 * The Dispatch plugin SDK (docs/plugins.md). A plugin's `web.js` exports `activate(d)`; `d` is
 * this object. There is no runtime in this package: the app hands the real SDK to the bundle.
 *
 * Two versions. A plugin whose `plugin.json` says `"sdk": 2` gets `DispatchSdkV2`: the plugin id is
 * bound, and the app's data comes as plain objects. A plugin that says `"sdk": 1`, or nothing, gets
 * `DispatchSdk` (version 1), which is kept for one release: its `api` and `stores` log a warning and
 * go away in the next major version of Dispatch.
 *
 * `declare const d: import('@dispatchd/sdk').DispatchSdkV2` is enough to type a plugin.
 */
import type * as React from 'react';

export type SdkVersion = 1 | 2;

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
  /** `badge`: a live count shown on the row; above 0 the phone's thread ⋯ button shows a dot. */
  threadMenu?: { id: string; label: string; icon?: string; when?(ctx: { tab: Terminal }): boolean; onPick(ctx: { tab: Terminal }): void; badge?: { subscribe(onChange: () => void): () => void; get(ctx: { tab: Terminal }): number } }[];
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
  options: { value: string; label: string; hint?: string; disabled?: boolean }[];
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

export interface MultiSelectProps {
  /** The picked values. Values that are not among the options are kept as they are. */
  value: string[];
  options: { value: string; label: string; note?: string }[];
  /** Called on every tap with the whole new list. */
  onChange(value: string[]): void;
  /** The trigger's accessible name ("Projects"); the trigger reads "Projects: All except 2". */
  ariaLabel: string;
  /** The panel heading. Default `ariaLabel`. */
  title?: string;
  /** The trigger's words. Default: `allLabel`, `noneLabel`, "All except 2", or "3 <noun>" / "3 selected". */
  summary?: string;
  allLabel?: string;
  noneLabel?: string;
  noun?: [string, string];
  /** The search box over the list. Default: on past 8 options. */
  searchable?: boolean;
  /** Default by screen width: `popover` on the desktop, `sheet` on the phone. */
  variant?: 'popover' | 'sheet';
  style?: React.CSSProperties;
  disabled?: boolean;
}

export interface SegmentedProps {
  value: string;
  /** 2 to 5 options. The picked option's `hint` shows under the control. */
  options: { value: string; label: string; hint?: string }[];
  onChange(value: string): void;
  ariaLabel: string;
  /** Default by screen width: `md` on the desktop, `lg` on the phone. */
  size?: 'md' | 'lg';
  style?: React.CSSProperties;
}

export interface SettingsGroupProps {
  /** The small heading over the card. */
  title?: string;
  /** A quiet note under the card. */
  footer?: React.ReactNode;
  /** Something small at the heading's right. */
  action?: React.ReactNode;
  children: React.ReactNode;
  style?: React.CSSProperties;
}

export interface SettingsRowProps {
  label: React.ReactNode;
  /** One short line under the label. */
  hint?: React.ReactNode;
  /** A small control on the right: a Toggle, a short Select, a number field, a MultiSelect trigger. */
  control?: React.ReactNode;
  /** A wide control on its own full-width line under the label (a Segmented, fields, a list). */
  children?: React.ReactNode;
  style?: React.CSSProperties;
}

/** The controls and styles both SDK versions hand out as `ui`. */
export interface UiKit {
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
  /**
   * The app's multi-pick: a small trigger that names the pick ("All projects", "All except 2")
   * and opens a panel (a popover on the desktop, a bottom sheet on the phone) with a search box,
   * Select all / None, and a scrolling checklist.
   */
  MultiSelect: React.ComponentType<MultiSelectProps>;
  /** A full-width segmented choice (a radiogroup) for 2 to 5 options, with the picked option's hint under it. */
  Segmented: React.ComponentType<SegmentedProps>;
  /** A grouped settings card: a small heading over rows split by a hairline. */
  SettingsGroup: React.ComponentType<SettingsGroupProps>;
  /** One settings row: label and hint on the left, a small control on the right, a wide control below. */
  SettingsRow: React.ComponentType<SettingsRowProps>;
  styles: { sectionLabel: React.CSSProperties; row: React.CSSProperties; item: React.CSSProperties; ghostBtn: React.CSSProperties; solidBtn(on: boolean): React.CSSProperties; chip: React.CSSProperties; fieldInput: React.CSSProperties };
}

/**
 * SDK version 1: the object a plugin gets when its manifest says `"sdk": 1` or names no version.
 * Kept for one release. Move to `DispatchSdkV2` (docs/plugins.md, "Moving a plugin to SDK version 2").
 * A call that passes another plugin's id is refused.
 */
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
  /**
   * The app's stores, typed by the fields a plugin reads; each has more.
   * @deprecated Goes away in the next major version. The first read logs one warning. Use `threads`, `projects`, `hooks.useThreads`, `hooks.useProjects` and `navigate` of `DispatchSdkV2`.
   */
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
  /**
   * The app's API client. The methods a plugin uses most; the object has more.
   * @deprecated Goes away in the next major version. The first read logs one warning. Use `docs`, `settings`, `worker`, `assist`, `model`, `files` and `plugin` of `DispatchSdkV2`.
   */
  api: {
    listSessions(): Promise<Session[]>;
    listTerminals(sessionId: string): Promise<Terminal[]>;
    listPlugins(): Promise<{ plugins: PluginRow[] }>;
    [method: string]: (...args: any[]) => any;
  };
  ui: UiKit;
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

// ── SDK version 2 ────────────────────────────────────────────────────────────────────────
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

/** A screen of the app, for `navigate`. A plugin's own view is `{ view: 'plugin:<id>:<view>' }`. */
export type Route =
  | { view: 'workspace'; projectId?: string; threadId?: string; agentId?: string }
  | { view: 'settings'; section?: string; subPage?: string }
  | { view: 'chat' }
  | { view: 'analytics' }
  | { view: `plugin:${string}` };

export interface AssistRequest {
  system?: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  maxTokens?: number;
  harness?: 'claude' | 'codex' | 'openrouter' | 'auto';
  model?: string;
  accountId?: string;
}
export interface AssistResult {
  text: string;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheCreateTokens?: number };
  ms: number;
  model: string;
  harness?: 'claude' | 'codex' | 'openrouter';
  accountId?: string | null;
  costUsd?: number | null;
}
export interface AssistUsage { calls: number; failed: number; inputTokens: number; outputTokens: number; costUsd: number; byModel: { model: string; harness: string; calls: number; inputTokens: number; outputTokens: number }[] }
export interface AssistShare { usedPercent: number; pluginPercent: number; pluginTokens: number; accountTokens: number; resetsAt: string | null }
export interface PluginBudget { percentWeekly: number | null; usdWeekly: number | null }

/**
 * SDK version 2: the object a plugin gets when its manifest says `"sdk": 2`. It is bound to the
 * plugin: no function takes a plugin id, so a bundle cannot name another plugin's documents,
 * settings, worker, files or budget. It gives no API client and no store. The object and its
 * namespaces are frozen.
 */
export interface DispatchSdkV2 {
  readonly version: 2;
  /** This plugin's id, as plugin.json names it. */
  readonly id: string;
  React: typeof React;
  h: typeof React.createElement;
  Fragment: typeof React.Fragment;
  hooks: {
    useState: typeof React.useState; useEffect: typeof React.useEffect; useMemo: typeof React.useMemo; useCallback: typeof React.useCallback; useRef: typeof React.useRef;
    useIsMobile(): boolean;
    /** The contributions of one kind that loaded plugins registered (`views`, `commands`, …). */
    useContributions(kind: keyof Contributions, filter?: (x: any) => boolean): any[];
    /** A document of this plugin as React state: `[value, set, loading]`, refreshed when the daemon says it changed. */
    useDoc<T>(key: string, fallback: T): [T, (next: T) => Promise<void>, boolean];
    /** The projects, as React state. The array is the same object until the list changes. */
    useProjects(): ProjectInfo[];
    /** The loaded threads of every project, as React state. */
    useThreads(): ThreadInfo[];
  };
  zustand: { create: <S>(init: (set: (partial: Partial<S> | ((s: S) => Partial<S>)) => void, get: () => S) => S) => Store<S> };
  /** This plugin's documents on the daemon (`threads:*-storage` lets threads reach them). */
  docs: {
    /** The document's value; the fallback when there is none. */
    get<T>(key: string, fallback: T): Promise<T>;
    set(key: string, value: unknown): Promise<void>;
    /** Removes the document; a missing one is not an error. */
    delete(key: string): Promise<void>;
    keys(): Promise<string[]>;
    /** Every document with its value, in one request. */
    entries<T = unknown>(): Promise<{ key: string; value: T }[]>;
  };
  /** This plugin's settings: one JSON value. `get` gives the fallback (null when you pass none) while nothing is saved. */
  settings: { get<T = unknown>(fallback?: T): Promise<T>; set(value: unknown): Promise<void> };
  threads: {
    /** The threads of every project whose list the app has loaded. */
    list(): ThreadInfo[];
    get(id: string): ThreadInfo | null;
    status(id: string): ThreadStatusInfo | null;
    /** Asks the app to read the thread list of one project (of every project when no id is given), and resolves with those threads. */
    load(projectId?: string): Promise<ThreadInfo[]>;
    /** Called when a thread is added, removed or changed, or a status changes. Returns the function that stops it; a reload stops it too. */
    onChange(fn: () => void): () => void;
  };
  projects: {
    list(): ProjectInfo[];
    /** The open project. */
    active(): ProjectInfo | null;
    onChange(fn: () => void): () => void;
  };
  /** Go to a screen: a thread, a project, a settings section, a plugin view. One history entry. */
  navigate(route: Route): void;
  actions: {
    setView(key: string): void;
    openThread(projectId: string, terminalId: string): Promise<void>;
    openSettings(sectionKey: string): void;
    /** An unseen count on one of this plugin's views: the view's id, or its key `plugin:<id>:<view>`. 0 clears it. Another plugin's key is ignored. */
    setBadge(view: string, n: number): void;
    /** Opens the new-automation dialog with the prompt (and the cron and name) filled. Nothing is saved until the person presses Save. */
    openSchedule(p: { projectId?: string; prompt: string; cron?: string; label?: string }): void;
    /** Opens the new-thread dialog listing one thread per prompt. Nothing starts until the person presses Start. */
    openNewThreads(p: { projectId?: string; prompts: string[] }): void;
    /** Opens the review sheet for a drafted skill; resolves with `{ id }` on Create, null on Cancel. */
    createSkill(draft: { id?: string; name: string; description?: string; body: string; projects?: string[]; projectId?: string }): Promise<{ id: string } | null>;
  };
  ui: UiKit & {
    /** A short line at the bottom of the screen, gone after a few seconds. */
    hint(text: string): void;
    copyText(text: string): Promise<void>;
  };
  /** Icon components by name (`eye`, `star`, `sparkle`, `sun`, …); the same names `contributes.views[].icon` takes. */
  icons: Record<string, React.ComponentType<any>>;
  /** The daemon's event stream; a listener is dropped when the plugin reloads. */
  events: { on(type: string | string[], handler: (e: ServerEvent) => void): () => void };
  /**
   * One model call through the daemon (`model:assist`). `harness` runs one harness only (no
   * fallback); `auto` runs on the account with the most room; absent = Claude, then OpenRouter.
   */
  assist(req: AssistRequest): Promise<AssistResult>;
  /** What this plugin's model calls cost, and its budget. */
  model: {
    usage(range?: { from?: string; to?: string }): Promise<AssistUsage>;
    share(q?: { accountId?: string; harness?: 'claude' | 'codex' }): Promise<{ fiveHour: AssistShare | null; sevenDay: AssistShare | null }>;
    budget(): Promise<PluginBudget>;
    setBudget(budget: Partial<PluginBudget>): Promise<PluginBudget>;
  };
  /** This plugin itself. */
  plugin: {
    /** Turns this plugin off, as the switch on the Plugins page does. */
    disable(): Promise<void>;
  };
  /** The file references threads registered with this plugin (`POST /api/plugins/<id>/files`). */
  files: {
    /** The address of a file's bytes, for an `<img src>` or the FileViewer. */
    url(fileId: string): string;
    /** Removes the reference; a missing one is not an error. */
    remove(fileId: string): Promise<void>;
  };
  /** This plugin's worker, through the daemon's proxy: `worker.fetch('jobs/run', { method: 'POST' })`. A path that leaves the worker is refused. */
  worker: { fetch(path: string, init?: RequestInit): Promise<Response> };
  /** An app-root-relative path (`/api/...`, `/plugins/...`) as the browser must request it. */
  url(path: string): string;
  /** Replaces this plugin's contributions. */
  register(c: Contributions): void;
}

declare global { interface Window { dispatch?: DispatchSdk } }
