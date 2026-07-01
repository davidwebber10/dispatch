import { create } from 'zustand';

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

interface SettingsState {
  fontSize: number;
  scrollback: number;
  sidebarFontSize: number;
  projectFontSize: number;
  density: Density;
  accent: string;
  coordinatorName: string;   // raw value; empty falls back to "Dispatch" at display (see useDispatchName)
  notify: boolean;
  pushEnabled: boolean;
  multiPane: boolean;
  sttProvider: string;
  sttModel: string;
  sttSecretName: string;
  setCoordinatorName: (name: string) => void;
  setFontSize: (n: number) => void;
  setScrollback: (n: number) => void;
  setSidebarFontSize: (n: number) => void;
  setProjectFontSize: (n: number) => void;
  setDensity: (d: Density) => void;
  setAccent: (c: string) => void;
  setNotify: (b: boolean) => Promise<void>;
  setPushEnabled: (b: boolean) => Promise<void>;
  setMultiPane: (b: boolean) => void;
  setSttProvider: (id: string) => void;
  setSttModel: (id: string) => void;
  setSttSecretName: (name: string) => void;
}

function load<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v == null ? fallback : (JSON.parse(v) as T); } catch { return fallback; }
}
function save(key: string, v: unknown) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* ignore */ } }

function applyAccent(c: string) {
  try { document.documentElement.style.setProperty('--color-accent', c); } catch { /* ssr/jsdom */ }
}

const initialAccent = load('dispatch:accent', ACCENTS[0] as string);
applyAccent(initialAccent);

export const useSettings = create<SettingsState>((set) => ({
  fontSize: load('dispatch:fontSize', 13),
  scrollback: load('dispatch:scrollback', 20000),
  sidebarFontSize: load('dispatch:sidebarFontSize', 13),
  projectFontSize: load('dispatch:projectFontSize', 15),
  density: load<Density>('dispatch:density', 'cozy'),
  accent: initialAccent,
  coordinatorName: load('dispatch:coordinatorName', 'Dispatch'),
  notify: load('dispatch:notify', false),
  pushEnabled: load('dispatch:pushEnabled', false),
  multiPane: load('dispatch:multiPane', true),
  sttProvider: load('dispatch:sttProvider', 'groq'),
  sttModel: load('dispatch:sttModel', 'whisper-large-v3-turbo'),
  sttSecretName: load('dispatch:sttSecretName', ''),
  setFontSize: (n) => { const fontSize = Math.max(9, Math.min(22, Math.round(n))); save('dispatch:fontSize', fontSize); set({ fontSize }); },
  setScrollback: (n) => { const scrollback = Math.max(1000, Math.min(100000, Math.round(n))); save('dispatch:scrollback', scrollback); set({ scrollback }); },
  setSidebarFontSize: (n) => { const sidebarFontSize = Math.max(10, Math.min(18, Math.round(n))); save('dispatch:sidebarFontSize', sidebarFontSize); set({ sidebarFontSize }); },
  setProjectFontSize: (n) => { const projectFontSize = Math.max(11, Math.min(22, Math.round(n))); save('dispatch:projectFontSize', projectFontSize); set({ projectFontSize }); },
  setDensity: (density) => { save('dispatch:density', density); set({ density }); },
  setCoordinatorName: (coordinatorName) => { save('dispatch:coordinatorName', coordinatorName); set({ coordinatorName }); },
  setMultiPane: (b) => { save('dispatch:multiPane', b); set({ multiPane: b }); },
  setAccent: (accent) => { save('dispatch:accent', accent); applyAccent(accent); set({ accent }); },
  setSttProvider: (id) => { save('dispatch:sttProvider', id); set({ sttProvider: id }); },
  setSttModel: (id) => { save('dispatch:sttModel', id); set({ sttModel: id }); },
  setSttSecretName: (name) => { save('dispatch:sttSecretName', name); set({ sttSecretName: name }); },
  setNotify: async (b) => {
    if (b && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      try { await Notification.requestPermission(); } catch { /* denied */ }
    }
    const notify = b && typeof Notification !== 'undefined' && Notification.permission === 'granted';
    save('dispatch:notify', notify); set({ notify });
  },
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
 * The coordinator's user-facing display name — the ONE place the "fall back to Dispatch"
 * rule lives. Every site that shows the coordinator's name (overseer header, message
 * attribution, project entry button, the Dispatch tab) reads from here, so a change in
 * Settings updates all of them live (zustand subscription). An empty/whitespace stored
 * value renders as "Dispatch". Do not read `dispatch:coordinatorName` from localStorage
 * directly anywhere else.
 */
export const useDispatchName = (): string => useSettings((s) => s.coordinatorName.trim() || 'Dispatch');
