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
  notify: boolean;
  setFontSize: (n: number) => void;
  setScrollback: (n: number) => void;
  setSidebarFontSize: (n: number) => void;
  setProjectFontSize: (n: number) => void;
  setDensity: (d: Density) => void;
  setAccent: (c: string) => void;
  setNotify: (b: boolean) => Promise<void>;
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
  notify: load('dispatch:notify', false),
  setFontSize: (n) => { const fontSize = Math.max(9, Math.min(22, Math.round(n))); save('dispatch:fontSize', fontSize); set({ fontSize }); },
  setScrollback: (n) => { const scrollback = Math.max(1000, Math.min(100000, Math.round(n))); save('dispatch:scrollback', scrollback); set({ scrollback }); },
  setSidebarFontSize: (n) => { const sidebarFontSize = Math.max(10, Math.min(18, Math.round(n))); save('dispatch:sidebarFontSize', sidebarFontSize); set({ sidebarFontSize }); },
  setProjectFontSize: (n) => { const projectFontSize = Math.max(11, Math.min(22, Math.round(n))); save('dispatch:projectFontSize', projectFontSize); set({ projectFontSize }); },
  setDensity: (density) => { save('dispatch:density', density); set({ density }); },
  setAccent: (accent) => { save('dispatch:accent', accent); applyAccent(accent); set({ accent }); },
  setNotify: async (b) => {
    if (b && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      try { await Notification.requestPermission(); } catch { /* denied */ }
    }
    const notify = b && typeof Notification !== 'undefined' && Notification.permission === 'granted';
    save('dispatch:notify', notify); set({ notify });
  },
}));
