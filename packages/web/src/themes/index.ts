import type { Theme } from './types';
import { dispatchDark } from './dispatchDark';
import { dispatchLight } from './dispatchLight';
import { githubLight, githubDark } from './github';
import { oneDark } from './oneDark';
import { dracula } from './dracula';
import { nord } from './nord';
import { solarizedLight, solarizedDark } from './solarized';
import { catppuccinLatte, catppuccinMocha } from './catppuccin';
import { tokyoNight } from './tokyoNight';

export type { Theme, TerminalPalette, TokenName } from './types';
export { resolveTokens, cssVarName, termVarName, onAccent } from './types';

/** Every theme, in the order Settings shows them: light themes, then dark themes. */
export const THEMES: readonly Theme[] = [
  dispatchLight, githubLight, solarizedLight, catppuccinLatte,
  dispatchDark, githubDark, oneDark, dracula, nord, solarizedDark, catppuccinMocha, tokyoNight,
];

export const DEFAULT_THEME_ID = dispatchDark.id;
export const SYSTEM_LIGHT = dispatchLight;
export const SYSTEM_DARK = dispatchDark;

/** The theme setting: 'system' follows the device (Dispatch Light / Dark), else a theme id. */
export type ThemeSetting = 'system' | string;

export function getTheme(id: string): Theme | undefined {
  return THEMES.find((t) => t.id === id);
}

/** The theme a setting means now. An unknown id (a theme since removed) falls back to the default. */
export function themeFor(setting: ThemeSetting, prefersDark: boolean): Theme {
  if (setting === 'system') return prefersDark ? SYSTEM_DARK : SYSTEM_LIGHT;
  return getTheme(setting) ?? dispatchDark;
}

export { dispatchDark, dispatchLight };
