import { mix, bestOn } from './color';

/**
 * Theme registry types (Settings → Appearance → Theme). A theme gives the color tokens of
 * theme.css; a token named `x` is written as `--color-x`, a `syntax-x` token as `--syntax-x`, and
 * the terminal palette as `--term-*` (and handed to xterm as is). A theme must give the core
 * tokens; the rest are derived from them (deriveTokens) unless the theme sets them.
 */
export const CORE_TOKENS = [
  'canvas', 'base', 'pane', 'elevated', 'hover', 'border',
  'text-primary', 'text-secondary', 'text-tertiary',
  'red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'pink',
] as const;

export const DERIVED_TOKENS = [
  'terminal', 'modal', 'selected', 'border-strong', 'border-hover',
  'on-accent',
  'text-emphasis', 'text-body', 'text-muted', 'text-dim', 'text-faint',
  'status-green', 'status-yellow', 'status-amber', 'status-red', 'status-coral', 'status-blue', 'on-danger',
  'chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5', 'chart-other',
  'overlay', 'shadow', 'shadow-strong', 'code-bg',
  'syntax-bg', 'syntax-text', 'syntax-comment', 'syntax-keyword', 'syntax-tag', 'syntax-literal',
  'syntax-string', 'syntax-number', 'syntax-function', 'syntax-class',
] as const;

export type CoreToken = typeof CORE_TOKENS[number];
export type DerivedToken = typeof DERIVED_TOKENS[number];
export type TokenName = CoreToken | DerivedToken | 'accent';
export type ThemeTokens = Record<CoreToken, string> & Partial<Record<DerivedToken, string>>;

/** The xterm palette (the same keys as xterm's ITheme). */
export interface TerminalPalette {
  background: string; foreground: string; cursor: string; cursorAccent?: string; selectionBackground: string;
  black: string; red: string; green: string; yellow: string; blue: string; magenta: string; cyan: string; white: string;
  brightBlack: string; brightRed: string; brightGreen: string; brightYellow: string;
  brightBlue: string; brightMagenta: string; brightCyan: string; brightWhite: string;
}

export interface Theme {
  id: string;
  name: string;
  kind: 'light' | 'dark';
  tokens: ThemeTokens;
  terminal: TerminalPalette;
  /** The theme's own accent; the user's accent setting overrides it. Defaults to the theme's blue. */
  accent?: string;
}

/** Every token with a value: the theme's own, else derived from its core tokens. */
export function resolveTokens(theme: Theme): Record<TokenName, string> {
  const t = theme.tokens;
  const dark = theme.kind === 'dark';
  const accent = theme.accent ?? t.blue;
  const emphasis = t['text-emphasis'] ?? (dark ? '#FFFFFF' : '#000000');
  const amber = t['status-amber'] ?? mix(t.yellow, t.orange, 0.5);
  const coral = t['status-coral'] ?? mix(t.red, t.orange, 0.25);
  const derived: Record<DerivedToken, string> = {
    terminal: theme.terminal.background,
    modal: dark ? mix(t.pane, t.elevated, 0.5) : t.pane,
    selected: mix(t.hover, t['text-primary'], 0.05),
    'border-strong': mix(t.border, t['text-primary'], 0.03),
    'border-hover': mix(t.border, t['text-primary'], 0.1),
    'on-accent': onAccent(accent),
    'text-emphasis': emphasis,
    'text-body': mix(t['text-primary'], t['text-secondary'], 0.3),
    'text-muted': mix(t['text-primary'], t['text-secondary'], 0.6),
    'text-dim': mix(t['text-secondary'], t['text-tertiary'], 0.6),
    'text-faint': mix(t['text-tertiary'], t.base, 0.3),
    'status-green': t.green,
    'status-yellow': t.yellow,
    'status-amber': amber,
    'status-red': t.red,
    'status-coral': coral,
    'status-blue': t.blue,
    'on-danger': bestOn(coral, mix(coral, '#000000', 0.85), '#FFFFFF'),
    'chart-1': t.blue, 'chart-2': t.orange, 'chart-3': t.green, 'chart-4': t.yellow, 'chart-5': t.pink,
    'chart-other': mix(t['text-secondary'], t['text-tertiary'], 0.5),
    overlay: dark ? 'rgba(0,0,0,.55)' : 'rgba(15,15,20,.32)',
    shadow: dark ? 'rgba(0,0,0,.5)' : 'rgba(15,15,20,.14)',
    'shadow-strong': dark ? 'rgba(0,0,0,.85)' : 'rgba(15,15,20,.24)',
    'code-bg': t.elevated,
    'syntax-bg': t.elevated,
    'syntax-text': t['text-primary'],
    'syntax-comment': t['text-tertiary'],
    'syntax-keyword': t.purple,
    'syntax-tag': t.red,
    'syntax-literal': t.cyan,
    'syntax-string': t.green,
    'syntax-number': t.orange,
    'syntax-function': t.blue,
    'syntax-class': t.yellow,
  };
  const out = { accent } as Record<TokenName, string>;
  for (const k of CORE_TOKENS) out[k] = t[k];
  for (const k of DERIVED_TOKENS) out[k] = t[k] ?? derived[k];
  return out;
}

/** Text on a filled accent: a very dark shade of the accent, or white, whichever reads better. */
export function onAccent(accent: string): string {
  return bestOn(accent, mix(accent, '#000000', 0.85), '#FFFFFF');
}

/** The CSS custom property a token is written to. */
export function cssVarName(token: TokenName): string {
  return token.startsWith('syntax-') ? `--${token}` : `--color-${token}`;
}

/** `brightBlack` → `--term-bright-black`. */
export function termVarName(key: keyof TerminalPalette): string {
  if (key === 'selectionBackground') return '--term-selection';
  return `--term-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}
