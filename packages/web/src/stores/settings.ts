import { create } from 'zustand';
import { syncAppIcons } from '../lib/appIcon';
import { api } from '../api/client';
import { setThemeSetting, useActiveTheme } from '../themes/apply';
import { DEFAULT_THEME_ID, getTheme, type ThemeSetting } from '../themes';

// literal color: the accent swatches the user picks from (content, not chrome).
export const ACCENTS = [
  '#3ECF6A', // green
  '#30D158', // emerald
  '#56B6C2', // teal
  '#0091FF', // blue
  '#5A8DD6', // steel
  '#5E5CE6', // indigo
  '#C792EA', // purple
  '#FF6AC1', // pink
  '#F0616D', // red
  '#FF9F0A', // orange
  '#F5C542', // yellow
] as const;

export type Density = 'compact' | 'cozy' | 'roomy';

/** The editor the doc viewer's "Open in editor" uses, through its URL scheme ('' = none, the button stays hidden). */
export type DocEditor = '' | 'vscode' | 'cursor' | 'zed';
const EDITORS: readonly DocEditor[] = ['', 'vscode', 'cursor', 'zed'];

/**
 * Sidebar list caps (THREADS / FILES sections). 0 is the "All" sentinel — no cap.
 * The stepper walks 3…50, then one more step up lands on All; step logic lives here
 * (not in the component) so both settings shells share it and it is unit-testable.
 */
export const SIDEBAR_LIMIT_MIN = 3;
export const SIDEBAR_LIMIT_MAX = 50;

export function stepSidebarLimit(current: number, delta: 1 | -1): number {
  if (current === 0) return delta === 1 ? 0 : SIDEBAR_LIMIT_MAX;
  const next = current + delta;
  if (next > SIDEBAR_LIMIT_MAX) return 0;
  return Math.max(SIDEBAR_LIMIT_MIN, next);
}

export function formatSidebarLimit(n: number): string {
  return n === 0 ? 'All' : String(n);
}

function clampSidebarLimit(n: number): number {
  if (!Number.isFinite(n) || n === 0) return Number.isFinite(n) ? 0 : 10;
  return Math.max(SIDEBAR_LIMIT_MIN, Math.min(SIDEBAR_LIMIT_MAX, Math.round(n)));
}

interface SettingsState {
  fontSize: number;
  scrollback: number;
  sidebarFontSize: number;
  projectFontSize: number;
  sidebarMaxThreads: number;  // 0 = All (no cap)
  sidebarMaxFiles: number;    // 0 = All (no cap)
  /**
   * Whether a project card shows its FILES shelf at all. Off hides the shelf outright
   * — header, chevron and rows — for people who open files from the browser and never
   * want the pinned list in the sidebar. Pinning still works and "Browse Files" stays;
   * this only controls the shelf.
   */
  showPinnedFiles: boolean;
  density: Density;
  /** The user's accent, or '' for the theme's own accent ("Theme default"). Overrides the theme's when set. */
  accent: string;
  /** 'system' follows the device (Dispatch Light / Dark); else a theme id (src/themes). Per device. */
  theme: ThemeSetting;
  /**
   * Raw value; empty falls back to "Control Plane" at display (see useDispatchName). The same on
   * every device: stored on the daemon (/api/settings/coordinator), cached here for first paint.
   */
  coordinatorName: string;
  pushEnabled: boolean;
  multiPane: boolean;
  /**
   * Dictation (Settings → Dictation). The same on every device: stored on the daemon
   * (/api/settings/dictation), cached here so the mic works before the daemon answers.
   */
  sttProvider: string;
  sttModel: string;
  sttSecretName: string;
  /**
   * Spelling help in the mobile CLI/PTY composer. On by default — most of what is
   * typed there is prose aimed at the agent. Toggled from the soft-key row above the
   * input, because a run of shell commands is exactly when you want it off, and in
   * Settings → Appearance. The Pretty composer is always on and has no toggle: it takes
   * prose only.
   */
  ptyAutocorrect: boolean;
  editor: DocEditor;
  /**
   * The one-line "Long responses read best in Pretty" nudge above a CLI thread
   * (components/tabs/CliPrettyHint.tsx). Off hides it on every thread; the hint's own ×
   * sets this too, so the two are one switch. Defaults to the older per-device × state so
   * a dismissal made before this setting existed still holds.
   */
  showPrettyHint: boolean;
  /**
   * The red "agents paused on a usage limit" banner (#127). Per-device: off hides it on this
   * device only. The warning push is a separate daemon-wide switch in Settings > Notifications.
   */
  showUsageBanner: boolean;
  /** What the usage ring shows in its middle on this device (2026-11-07): the tool's logo or the percent used. */
  usageRingCenter: 'logo' | 'percent';
  setCoordinatorName: (name: string) => void;
  setFontSize: (n: number) => void;
  setScrollback: (n: number) => void;
  setSidebarFontSize: (n: number) => void;
  setProjectFontSize: (n: number) => void;
  setSidebarMaxThreads: (n: number) => void;
  setSidebarMaxFiles: (n: number) => void;
  setShowPinnedFiles: (b: boolean) => void;
  setDensity: (d: Density) => void;
  setAccent: (c: string) => void;
  setTheme: (t: ThemeSetting) => void;
  setPushEnabled: (b: boolean) => Promise<void>;
  /** Set the switch only (saved), with no network call: for code that already did the work. */
  setPushEnabledLocal: (b: boolean) => void;
  setMultiPane: (b: boolean) => void;
  setSttProvider: (id: string) => void;
  setSttModel: (id: string) => void;
  setSttSecretName: (name: string) => void;
  setPtyAutocorrect: (b: boolean) => void;
  setEditor: (e: DocEditor) => void;
  setShowPrettyHint: (b: boolean) => void;
  setShowUsageBanner: (b: boolean) => void;
  setUsageRingCenter: (v: 'logo' | 'percent') => void;
}

/** The pre-setting per-device dismissal flag the hint's × wrote (kept as the default's source). */
export const CLI_PRETTY_HINT_KEY = 'dispatch:cliPrettyHint:dismissed';
function legacyPrettyHintShown(): boolean {
  try { return localStorage.getItem(CLI_PRETTY_HINT_KEY) !== '1'; } catch { return true; }
}

function load<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v == null ? fallback : (JSON.parse(v) as T); } catch { return fallback; }
}
function save(key: string, v: unknown) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* ignore */ } }

// Keep the PWA/browser icons in the accent color. Debounced: the custom color
// picker fires a change per drag frame, and each sync renders + uploads 4 PNGs.
let iconTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleIconSync(accent: string) {
  clearTimeout(iconTimer);
  iconTimer = setTimeout(() => void syncAppIcons(accent), 600);
}

const validTheme = (t: unknown): ThemeSetting => (t === 'system' || (typeof t === 'string' && getTheme(t)) ? t as ThemeSetting : DEFAULT_THEME_ID);
const initialTheme = validTheme(load<string>('dispatch:theme', DEFAULT_THEME_ID));
const initialAccent = load('dispatch:accent', '');
setThemeSetting(initialTheme, initialAccent);
/** The accent on screen: the user's, else the theme's. */
const effectiveAccent = () => useActiveTheme.getState().accent;
// A non-default accent may predate the daemon growing the icons endpoint (or
// another device may have changed it since) — re-sync once per boot.
if (effectiveAccent().toUpperCase() !== ACCENTS[0]) scheduleIconSync(effectiveAccent());

export const STT_DEFAULTS = { provider: 'groq', model: 'whisper-large-v3-turbo' } as const;

export const useSettings = create<SettingsState>((set, get) => ({
  fontSize: load('dispatch:fontSize', 13),
  scrollback: load('dispatch:scrollback', 20000),
  sidebarFontSize: load('dispatch:sidebarFontSize', 13),
  projectFontSize: load('dispatch:projectFontSize', 15),
  sidebarMaxThreads: load('dispatch:sidebarMaxThreads', 10),
  sidebarMaxFiles: load('dispatch:sidebarMaxFiles', 10),
  showPinnedFiles: load('dispatch:showPinnedFiles', true),
  density: load<Density>('dispatch:density', 'cozy'),
  accent: initialAccent,
  theme: initialTheme,
  coordinatorName: load('dispatch:coordinatorName', 'Control Plane'),
  pushEnabled: load('dispatch:pushEnabled', false),
  multiPane: load('dispatch:multiPane', true),
  sttProvider: load('dispatch:sttProvider', STT_DEFAULTS.provider),
  sttModel: load('dispatch:sttModel', STT_DEFAULTS.model),
  sttSecretName: load('dispatch:sttSecretName', ''),
  ptyAutocorrect: load<boolean>('dispatch:ptyAutocorrect', true),
  editor: ((e) => (EDITORS.includes(e) ? e : ''))(load<DocEditor>('dispatch:editor', '')),
  showPrettyHint: load<boolean>('dispatch:showPrettyHint', legacyPrettyHintShown()),
  showUsageBanner: load<boolean>('dispatch:usageBanner', true) !== false,
  usageRingCenter: load<string>('dispatch:usageRingCenter', 'logo') === 'percent' ? 'percent' : 'logo',
  setFontSize: (n) => { const fontSize = Math.max(9, Math.min(22, Math.round(n))); save('dispatch:fontSize', fontSize); set({ fontSize }); },
  setScrollback: (n) => { const scrollback = Math.max(1000, Math.min(100000, Math.round(n))); save('dispatch:scrollback', scrollback); set({ scrollback }); },
  setSidebarFontSize: (n) => { const sidebarFontSize = Math.max(10, Math.min(18, Math.round(n))); save('dispatch:sidebarFontSize', sidebarFontSize); set({ sidebarFontSize }); },
  setProjectFontSize: (n) => { const projectFontSize = Math.max(11, Math.min(22, Math.round(n))); save('dispatch:projectFontSize', projectFontSize); set({ projectFontSize }); },
  setSidebarMaxThreads: (n) => { const sidebarMaxThreads = clampSidebarLimit(n); save('dispatch:sidebarMaxThreads', sidebarMaxThreads); set({ sidebarMaxThreads }); },
  setSidebarMaxFiles: (n) => { const sidebarMaxFiles = clampSidebarLimit(n); save('dispatch:sidebarMaxFiles', sidebarMaxFiles); set({ sidebarMaxFiles }); },
  setShowPinnedFiles: (b) => { save('dispatch:showPinnedFiles', b); set({ showPinnedFiles: b }); },
  setDensity: (density) => { save('dispatch:density', density); set({ density }); },
  setCoordinatorName: (coordinatorName) => { save('dispatch:coordinatorName', coordinatorName); set({ coordinatorName }); scheduleCoordinatorPut(coordinatorName); },
  setMultiPane: (b) => { save('dispatch:multiPane', b); set({ multiPane: b }); },
  setAccent: (accent) => { save('dispatch:accent', accent); set({ accent }); setThemeSetting(get().theme, accent); scheduleIconSync(effectiveAccent()); },
  setTheme: (t) => {
    const theme = validTheme(t);
    const before = effectiveAccent();
    save('dispatch:theme', theme); set({ theme }); setThemeSetting(theme, get().accent);
    if (effectiveAccent() !== before) scheduleIconSync(effectiveAccent());
  },
  setSttProvider: (id) => { save('dispatch:sttProvider', id); set({ sttProvider: id }); putShared(() => api.putDictationSettings({ provider: id })); },
  setSttModel: (id) => { save('dispatch:sttModel', id); set({ sttModel: id }); putShared(() => api.putDictationSettings({ model: id })); },
  setSttSecretName: (name) => { save('dispatch:sttSecretName', name); set({ sttSecretName: name }); putShared(() => api.putDictationSettings({ secretName: name })); },
  setPtyAutocorrect: (b) => { save('dispatch:ptyAutocorrect', b); set({ ptyAutocorrect: b }); },
  setEditor: (e) => { const editor = EDITORS.includes(e) ? e : ''; save('dispatch:editor', editor); set({ editor }); },
  setShowPrettyHint: (b) => { save('dispatch:showPrettyHint', b); set({ showPrettyHint: b }); },
  setShowUsageBanner: (b) => { save('dispatch:usageBanner', b); set({ showUsageBanner: b }); },
  setUsageRingCenter: (v) => { save('dispatch:usageRingCenter', v); set({ usageRingCenter: v }); },
  setPushEnabledLocal: (b) => { save('dispatch:pushEnabled', b); set({ pushEnabled: b }); },
  setPushEnabled: async (b) => {
    const push = await import('../lib/push');
    if (b) {
      const r = await push.enablePush();
      if (r === 'superseded') return; // a newer request owns the switch
      get().setPushEnabledLocal(r === 'ok');
      if (r !== 'ok') throw new Error(r); // surfaced by the toggle for messaging (denied / unsupported / ios-install / timeout)
    } else {
      if (await push.disablePush()) get().setPushEnabledLocal(false); // false: replaced by a newer request, or timed out
    }
  },
}));

/** Write a same-on-every-device setting through to the daemon. Best effort: the local value already changed. */
function putShared(call: () => Promise<unknown> | undefined) {
  try { void call()?.catch(() => {}); } catch { /* an API without the route (tests, an old daemon) */ }
}

// The name field saves as you type: one PUT once typing pauses, not one per keystroke.
let coordinatorTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleCoordinatorPut(name: string) {
  clearTimeout(coordinatorTimer);
  coordinatorTimer = setTimeout(() => putShared(() => api.putCoordinatorSettings({ name })), 400);
}

const STT_KEYS = ['dispatch:sttProvider', 'dispatch:sttModel', 'dispatch:sttSecretName'] as const;
const hasLocal = (key: string) => { try { return localStorage.getItem(key) != null; } catch { return false; } };

/**
 * Load the two same-on-every-device settings (Dictation, the Control Plane name) from the daemon,
 * once at launch. They used to be per device, in localStorage: when the daemon has none yet
 * (`saved: false`) and this device has its own, they are uploaded once, and the daemon's copy is
 * used from then on. localStorage stays as a cache, so the first paint and an offline page keep the
 * last known values.
 */
export async function loadSharedSettings(): Promise<void> {
  const { setState, getState } = useSettings;
  await Promise.all([
    (async () => {
      let d = await api.getDictationSettings();
      if (!d.saved && STT_KEYS.some(hasLocal)) {
        const s = getState();
        d = await api.putDictationSettings({ provider: s.sttProvider, model: s.sttModel, secretName: s.sttSecretName });
      }
      if (!d.saved) return;
      const next = {
        sttProvider: d.provider ?? STT_DEFAULTS.provider,
        sttModel: d.model ?? STT_DEFAULTS.model,
        sttSecretName: d.secretName ?? '',
      };
      save('dispatch:sttProvider', next.sttProvider); save('dispatch:sttModel', next.sttModel); save('dispatch:sttSecretName', next.sttSecretName);
      setState(next);
    })().catch(() => { /* keep the cached values */ }),
    (async () => {
      let c = await api.getCoordinatorSettings();
      if (!c.saved && hasLocal('dispatch:coordinatorName')) c = await api.putCoordinatorSettings({ name: getState().coordinatorName });
      if (!c.saved) return;
      const coordinatorName = c.name ?? '';
      save('dispatch:coordinatorName', coordinatorName);
      setState({ coordinatorName });
    })().catch(() => { /* keep the cached value */ }),
  ]);
}

/**
 * The coordinator's user-facing display name — the ONE place the "fall back to Control
 * Plane" rule lives. Every site that shows the coordinator's name (overseer header, message
 * attribution, project entry button, the coordinator's own tab) reads from here, so a change in
 * Settings updates all of them live (zustand subscription). An empty/whitespace stored
 * value renders as "Control Plane". Do not read `dispatch:coordinatorName` from localStorage
 * directly anywhere else.
 */
export const useDispatchName = (): string => useSettings((s) => s.coordinatorName.trim() || 'Control Plane');
