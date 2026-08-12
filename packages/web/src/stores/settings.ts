import { create } from 'zustand';
import { syncAppIcons } from '../lib/appIcon';

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

/**
 * How mobile renders the thread list: `'threads'` is the existing projects → threads
 * drill-down (default); `'board'` is the cross-project board bucketed by what needs you.
 * Mobile-only, per-device (localStorage, no server sync) — see
 * docs/superpowers/specs/2026-07-20-thread-board-design.md "Placement, and the view-mode
 * setting".
 */
export type MobileViewMode = 'threads' | 'board';

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
  density: Density;
  accent: string;
  coordinatorName: string;   // raw value; empty falls back to "Control Plane" at display (see useDispatchName)
  pushEnabled: boolean;
  multiPane: boolean;
  resumeAdviceDismissed: boolean;
  sttProvider: string;
  sttModel: string;
  sttSecretName: string;
  mobileViewMode: MobileViewMode;
  /**
   * Spelling help in the mobile CLI/PTY composer. On by default — most of what is
   * typed there is prose aimed at the agent. Toggled from the soft-key row above the
   * input, because a run of shell commands is exactly when you want it off. The
   * Pretty composer is always on and has no toggle: it takes prose only.
   */
  ptyAutocorrect: boolean;
  setCoordinatorName: (name: string) => void;
  setFontSize: (n: number) => void;
  setScrollback: (n: number) => void;
  setSidebarFontSize: (n: number) => void;
  setProjectFontSize: (n: number) => void;
  setSidebarMaxThreads: (n: number) => void;
  setSidebarMaxFiles: (n: number) => void;
  setDensity: (d: Density) => void;
  setAccent: (c: string) => void;
  setPushEnabled: (b: boolean) => Promise<void>;
  setMultiPane: (b: boolean) => void;
  setResumeAdviceDismissed: (b: boolean) => void;
  setSttProvider: (id: string) => void;
  setSttModel: (id: string) => void;
  setSttSecretName: (name: string) => void;
  setMobileViewMode: (m: MobileViewMode) => void;
  setPtyAutocorrect: (b: boolean) => void;
}

function load<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v == null ? fallback : (JSON.parse(v) as T); } catch { return fallback; }
}
function save(key: string, v: unknown) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* ignore */ } }

function applyAccent(c: string) {
  try { document.documentElement.style.setProperty('--color-accent', c); } catch { /* ssr/jsdom */ }
}

// Keep the PWA/browser icons in the accent color. Debounced: the custom color
// picker fires a change per drag frame, and each sync renders + uploads 4 PNGs.
let iconTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleIconSync(accent: string) {
  clearTimeout(iconTimer);
  iconTimer = setTimeout(() => void syncAppIcons(accent), 600);
}

const initialAccent = load('dispatch:accent', ACCENTS[0] as string);
applyAccent(initialAccent);
// A non-default accent may predate the daemon growing the icons endpoint (or
// another device may have changed it since) — re-sync once per boot.
if (initialAccent !== ACCENTS[0]) scheduleIconSync(initialAccent);

export const useSettings = create<SettingsState>((set) => ({
  fontSize: load('dispatch:fontSize', 13),
  scrollback: load('dispatch:scrollback', 20000),
  sidebarFontSize: load('dispatch:sidebarFontSize', 13),
  projectFontSize: load('dispatch:projectFontSize', 15),
  sidebarMaxThreads: load('dispatch:sidebarMaxThreads', 10),
  sidebarMaxFiles: load('dispatch:sidebarMaxFiles', 10),
  density: load<Density>('dispatch:density', 'cozy'),
  accent: initialAccent,
  coordinatorName: load('dispatch:coordinatorName', 'Control Plane'),
  pushEnabled: load('dispatch:pushEnabled', false),
  multiPane: load('dispatch:multiPane', true),
  resumeAdviceDismissed: load('dispatch:resumeAdviceDismissed', false),
  sttProvider: load('dispatch:sttProvider', 'groq'),
  sttModel: load('dispatch:sttModel', 'whisper-large-v3-turbo'),
  sttSecretName: load('dispatch:sttSecretName', ''),
  mobileViewMode: load<MobileViewMode>('dispatch:mobileViewMode', 'threads'),
  ptyAutocorrect: load<boolean>('dispatch:ptyAutocorrect', true),
  setFontSize: (n) => { const fontSize = Math.max(9, Math.min(22, Math.round(n))); save('dispatch:fontSize', fontSize); set({ fontSize }); },
  setScrollback: (n) => { const scrollback = Math.max(1000, Math.min(100000, Math.round(n))); save('dispatch:scrollback', scrollback); set({ scrollback }); },
  setSidebarFontSize: (n) => { const sidebarFontSize = Math.max(10, Math.min(18, Math.round(n))); save('dispatch:sidebarFontSize', sidebarFontSize); set({ sidebarFontSize }); },
  setProjectFontSize: (n) => { const projectFontSize = Math.max(11, Math.min(22, Math.round(n))); save('dispatch:projectFontSize', projectFontSize); set({ projectFontSize }); },
  setSidebarMaxThreads: (n) => { const sidebarMaxThreads = clampSidebarLimit(n); save('dispatch:sidebarMaxThreads', sidebarMaxThreads); set({ sidebarMaxThreads }); },
  setSidebarMaxFiles: (n) => { const sidebarMaxFiles = clampSidebarLimit(n); save('dispatch:sidebarMaxFiles', sidebarMaxFiles); set({ sidebarMaxFiles }); },
  setDensity: (density) => { save('dispatch:density', density); set({ density }); },
  setCoordinatorName: (coordinatorName) => { save('dispatch:coordinatorName', coordinatorName); set({ coordinatorName }); },
  setMultiPane: (b) => { save('dispatch:multiPane', b); set({ multiPane: b }); },
  setResumeAdviceDismissed: (b) => { save('dispatch:resumeAdviceDismissed', b); set({ resumeAdviceDismissed: b }); },
  setAccent: (accent) => { save('dispatch:accent', accent); applyAccent(accent); set({ accent }); scheduleIconSync(accent); },
  setSttProvider: (id) => { save('dispatch:sttProvider', id); set({ sttProvider: id }); },
  setSttModel: (id) => { save('dispatch:sttModel', id); set({ sttModel: id }); },
  setSttSecretName: (name) => { save('dispatch:sttSecretName', name); set({ sttSecretName: name }); },
  setMobileViewMode: (m) => { save('dispatch:mobileViewMode', m); set({ mobileViewMode: m }); },
  setPtyAutocorrect: (b) => { save('dispatch:ptyAutocorrect', b); set({ ptyAutocorrect: b }); },
  setPushEnabled: async (b) => {
    if (b) {
      const r = await (await import('../lib/push')).enablePush();
      const on = r === 'ok';
      save('dispatch:pushEnabled', on); set({ pushEnabled: on });
      if (!on) throw new Error(r); // surfaced by the toggle for messaging (denied / unsupported / ios-install)
    } else {
      await (await import('../lib/push')).disablePush();
      save('dispatch:pushEnabled', false); set({ pushEnabled: false });
    }
  },
}));

/**
 * The coordinator's user-facing display name — the ONE place the "fall back to Control
 * Plane" rule lives. Every site that shows the coordinator's name (overseer header, message
 * attribution, project entry button, the coordinator's own tab) reads from here, so a change in
 * Settings updates all of them live (zustand subscription). An empty/whitespace stored
 * value renders as "Control Plane". Do not read `dispatch:coordinatorName` from localStorage
 * directly anywhere else.
 */
export const useDispatchName = (): string => useSettings((s) => s.coordinatorName.trim() || 'Control Plane');
