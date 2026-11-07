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
  /** One model call through the daemon (`model:assist`). */
  assist(plugin: string, req: { system?: string; messages: { role: 'user' | 'assistant'; content: string }[]; maxTokens?: number }): Promise<{ text: string; usage: { inputTokens: number; outputTokens: number }; ms: number; model: string }>;
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
