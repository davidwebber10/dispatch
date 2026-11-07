import type { Theme, TerminalPalette } from './types';

/** Solarized (Ethan Schoonover): base03…base3 and the eight accent colors. */
const S = {
  base03: '#002B36', base02: '#073642', base01: '#586E75', base00: '#657B83',
  base0: '#839496', base1: '#93A1A1', base2: '#EEE8D5', base3: '#FDF6E3',
  yellow: '#B58900', orange: '#CB4B16', red: '#DC322F', magenta: '#D33682',
  violet: '#6C71C4', blue: '#268BD2', cyan: '#2AA198', green: '#859900',
};

const ansi = {
  red: S.red, green: S.green, yellow: S.yellow, blue: S.blue, magenta: S.magenta, cyan: S.cyan,
  brightRed: S.orange, brightGreen: S.base01, brightYellow: S.base00, brightBlue: S.base0, brightMagenta: S.violet, brightCyan: S.base1,
};

const hues = { red: S.red, orange: S.orange, yellow: S.yellow, green: S.green, cyan: S.cyan, blue: S.blue, purple: S.violet, pink: S.magenta };
const syntax = {
  'syntax-keyword': S.green, 'syntax-tag': S.blue, 'syntax-literal': S.cyan, 'syntax-string': S.cyan,
  'syntax-number': S.magenta, 'syntax-function': S.blue, 'syntax-class': S.yellow,
};

export const solarizedLight: Theme = {
  id: 'solarized-light',
  name: 'Solarized Light',
  kind: 'light',
  accent: S.blue,
  tokens: {
    canvas: S.base2, base: S.base3, pane: S.base3, elevated: '#F5EEDA', hover: '#EAE3CE', border: '#DDD6C1',
    'text-primary': S.base02, 'text-secondary': '#4F646B', 'text-tertiary': S.base00,
    ...hues, ...syntax,
    'syntax-bg': S.base2, 'syntax-text': S.base00, 'syntax-comment': '#7E8F94',
  },
  terminal: {
    background: S.base3, foreground: S.base01, cursor: S.base02, selectionBackground: 'rgba(147,161,161,.35)',
    black: S.base02, white: S.base2, brightBlack: S.base03, brightWhite: S.base3, ...ansi,
  } as TerminalPalette,
};

export const solarizedDark: Theme = {
  id: 'solarized-dark',
  name: 'Solarized Dark',
  kind: 'dark',
  accent: S.blue,
  tokens: {
    canvas: '#00212B', base: S.base03, pane: S.base02, elevated: '#08394A', hover: '#0F4352', border: '#174B59',
    'text-primary': S.base2, 'text-secondary': S.base1, 'text-tertiary': S.base0,
    ...hues, ...syntax,
    'syntax-bg': S.base03, 'syntax-text': S.base0, 'syntax-comment': S.base01,
  },
  terminal: {
    background: S.base03, foreground: S.base0, cursor: S.base1, selectionBackground: 'rgba(7,54,66,.9)',
    black: S.base02, white: S.base2, brightBlack: S.base03, brightWhite: S.base3, ...ansi,
  } as TerminalPalette,
};
