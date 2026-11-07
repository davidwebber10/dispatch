import { create } from 'zustand';
import type { Theme, TerminalPalette, TokenName } from './types';
import { resolveTokens, cssVarName, termVarName, onAccent } from './types';
import { themeFor, dispatchDark, SYSTEM_LIGHT, SYSTEM_DARK, type ThemeSetting } from './index';

/**
 * Applying a theme: its tokens become CSS variables on <html> (theme.css reads them), plus
 * color-scheme and the theme-color meta. A payload is saved in localStorage so public/theme-boot.js
 * paints the next launch in the same theme before the app's scripts load (no flash).
 */
export const BOOT_KEY = 'dispatch:themeBoot';

interface BootTheme { id: string; scheme: 'light' | 'dark'; color: string; vars: Record<string, string> }
export interface BootPayload { fixed?: BootTheme; light?: BootTheme; dark?: BootTheme }

/** Every CSS variable of a theme. A non-empty `accent` is the user's own accent, over the theme's. */
export function themeVars(theme: Theme, accent: string): Record<string, string> {
  const tk = resolveTokens(theme);
  if (accent) { tk.accent = accent; tk['on-accent'] = onAccent(accent); }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(tk)) out[cssVarName(k as TokenName)] = v;
  for (const [k, v] of Object.entries(theme.terminal)) out[termVarName(k as keyof TerminalPalette)] = v;
  return out;
}

function boot(theme: Theme, accent: string): BootTheme {
  return { id: theme.id, scheme: theme.kind, color: resolveTokens(theme).base, vars: themeVars(theme, accent) };
}

export function bootPayload(setting: ThemeSetting, accent: string): BootPayload {
  if (setting === 'system') return { light: boot(SYSTEM_LIGHT, accent), dark: boot(SYSTEM_DARK, accent) };
  return { fixed: boot(themeFor(setting, true), accent) };
}

/** Write the theme onto the page. `setting` (when given) also saves the boot payload for the next launch. */
export function applyTheme(theme: Theme, accent: string, setting?: ThemeSetting): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  for (const [k, v] of Object.entries(themeVars(theme, accent))) root.style.setProperty(k, v);
  root.style.colorScheme = theme.kind;
  root.dataset.theme = theme.id;
  const color = resolveTokens(theme).base;
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) { meta = document.createElement('meta'); meta.setAttribute('name', 'theme-color'); document.head.appendChild(meta); }
  meta.setAttribute('content', color);
  if (setting !== undefined) {
    try { localStorage.setItem(BOOT_KEY, JSON.stringify(bootPayload(setting, accent))); } catch { /* private mode */ }
  }
}

/** The theme on screen now (for code that needs real colors: xterm, canvas, charts). */
export const useActiveTheme = create<{ theme: Theme; accent: string }>(() => ({ theme: dispatchDark, accent: dispatchDark.accent ?? '' }));

const DARK_QUERY = '(prefers-color-scheme: dark)';
function darkQuery(): MediaQueryList | null {
  try { return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(DARK_QUERY) : null; } catch { return null; }
}

let current: { setting: ThemeSetting; accent: string } = { setting: dispatchDark.id, accent: '' };
let listening: MediaQueryList | null = null;

function render() {
  const mq = darkQuery();
  const theme = themeFor(current.setting, mq ? mq.matches : true);
  applyTheme(theme, current.accent, current.setting);
  useActiveTheme.setState({ theme, accent: current.accent || (theme.accent ?? resolveTokens(theme).accent) });
}

/** Apply a theme setting and an accent ('' = the theme's). 'system' follows the device from now on. */
export function setThemeSetting(setting: ThemeSetting, accent: string): void {
  current = { setting, accent };
  if (!listening) {
    const mq = darkQuery();
    if (mq) {
      const onChange = () => { if (current.setting === 'system') render(); };
      if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange);
      else mq.addListener?.(onChange);
      listening = mq;
    }
  }
  render();
}
