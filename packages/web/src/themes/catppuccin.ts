import type { Theme } from './types';

/** Catppuccin (catppuccin.com/palette): Latte (light) and Mocha (dark). */
export const catppuccinLatte: Theme = {
  id: 'catppuccin-latte',
  name: 'Catppuccin Latte',
  kind: 'light',
  accent: '#8839EF',
  tokens: {
    canvas: '#DCE0E8', base: '#E6E9EF', pane: '#EFF1F5', elevated: '#E6E9EF', hover: '#DCE0E8', border: '#CCD0DA',
    'text-primary': '#4C4F69', 'text-secondary': '#5C5F77', 'text-tertiary': '#6C6F85',
    red: '#D20F39', orange: '#FE640B', yellow: '#DF8E1D', green: '#40A02B', cyan: '#179299', blue: '#1E66F5', purple: '#8839EF', pink: '#EA76CB',
    'syntax-bg': '#E6E9EF', 'syntax-text': '#4C4F69', 'syntax-comment': '#7C7F93', 'syntax-keyword': '#8839EF', 'syntax-tag': '#1E66F5',
    'syntax-literal': '#FE640B', 'syntax-string': '#40A02B', 'syntax-number': '#FE640B', 'syntax-function': '#1E66F5', 'syntax-class': '#DF8E1D',
  },
  terminal: {
    background: '#EFF1F5', foreground: '#4C4F69', cursor: '#DC8A78', selectionBackground: 'rgba(124,127,147,.3)',
    black: '#5C5F77', red: '#D20F39', green: '#40A02B', yellow: '#DF8E1D', blue: '#1E66F5', magenta: '#EA76CB', cyan: '#179299', white: '#ACB0BE',
    brightBlack: '#6C6F85', brightRed: '#D20F39', brightGreen: '#40A02B', brightYellow: '#DF8E1D',
    brightBlue: '#1E66F5', brightMagenta: '#EA76CB', brightCyan: '#179299', brightWhite: '#BCC0CC',
  },
};

export const catppuccinMocha: Theme = {
  id: 'catppuccin-mocha',
  name: 'Catppuccin Mocha',
  kind: 'dark',
  accent: '#CBA6F7',
  tokens: {
    canvas: '#11111B', base: '#181825', pane: '#1E1E2E', elevated: '#26263A', hover: '#313244', border: '#313244',
    'text-primary': '#CDD6F4', 'text-secondary': '#A6ADC8', 'text-tertiary': '#7F849C',
    red: '#F38BA8', orange: '#FAB387', yellow: '#F9E2AF', green: '#A6E3A1', cyan: '#94E2D5', blue: '#89B4FA', purple: '#CBA6F7', pink: '#F5C2E7',
    'syntax-bg': '#181825', 'syntax-text': '#CDD6F4', 'syntax-comment': '#9399B2', 'syntax-keyword': '#CBA6F7', 'syntax-tag': '#89B4FA',
    'syntax-literal': '#FAB387', 'syntax-string': '#A6E3A1', 'syntax-number': '#FAB387', 'syntax-function': '#89B4FA', 'syntax-class': '#F9E2AF',
  },
  terminal: {
    background: '#1E1E2E', foreground: '#CDD6F4', cursor: '#F5E0DC', selectionBackground: 'rgba(147,153,178,.3)',
    black: '#45475A', red: '#F38BA8', green: '#A6E3A1', yellow: '#F9E2AF', blue: '#89B4FA', magenta: '#F5C2E7', cyan: '#94E2D5', white: '#BAC2DE',
    brightBlack: '#585B70', brightRed: '#F38BA8', brightGreen: '#A6E3A1', brightYellow: '#F9E2AF',
    brightBlue: '#89B4FA', brightMagenta: '#F5C2E7', brightCyan: '#94E2D5', brightWhite: '#A6ADC8',
  },
};
