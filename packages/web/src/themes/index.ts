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
import { osLight, osDark } from './polywoodOs';
import { usesOsLook } from '../lib/hostContext';

export type { Theme, TerminalPalette, TokenName } from './types';
export { resolveTokens, cssVarName, termVarName, onAccent } from './types';

/** Every theme, in the order Settings shows them: light themes, then dark themes. */
export const THEMES: readonly Theme[] = [
  dispatchLight, githubLight, solarizedLight, catppuccinLatte, osLight,
  dispatchDark, githubDark, oneDark, dracula, nord, solarizedDark, catppuccinMocha, tokyoNight, osDark,
];

/**
 * With the OS look (lib/hostContext.ts usesOsLook: the business preview only, since 2026-11-11) the
 * 'system' pair is the OS pair and the default is 'system'. Every other page, a hosted box included,
 * keeps Dispatch Dark and the Dispatch pair.
 * The host context is fixed for the life of the page (lib/hostContext.ts), so these are read per call.
 */
const hosted = () => usesOsLook();
export const DEFAULT_THEME_ID = dispatchDark.id;
export const SYSTEM_LIGHT = dispatchLight;
export const SYSTEM_DARK = dispatchDark;
export function defaultThemeSetting(): ThemeSetting { return hosted() ? 'system' : DEFAULT_THEME_ID; }
export function systemLight(): Theme { return hosted() ? osLight : SYSTEM_LIGHT; }
export function systemDark(): Theme { return hosted() ? osDark : SYSTEM_DARK; }
/** The theme an unknown id falls back to. */
function fallbackTheme(prefersDark: boolean): Theme { return hosted() ? (prefersDark ? osDark : osLight) : dispatchDark; }

/** The theme setting: 'system' follows the device (Dispatch Light / Dark; OS Light / Dark when hosted), else a theme id. */
export type ThemeSetting = 'system' | string;

export function getTheme(id: string): Theme | undefined {
  return THEMES.find((t) => t.id === id);
}

/** The themes a person may pick: every theme, or only the OS pair when the profile hides the rest (lib/profile.ts). */
export function pickableThemes(allThemes: boolean): readonly Theme[] {
  return allThemes ? THEMES : [osLight, osDark];
}

/** The theme a setting means now. An unknown id (a theme since removed) falls back to the default. */
export function themeFor(setting: ThemeSetting, prefersDark: boolean): Theme {
  if (setting === 'system') return prefersDark ? systemDark() : systemLight();
  return getTheme(setting) ?? fallbackTheme(prefersDark);
}

export { dispatchDark, dispatchLight, osLight, osDark };
