import type { Theme } from './types';

/** Tokyo Night (the "night" style of folke/tokyonight). */
export const tokyoNight: Theme = {
  id: 'tokyo-night',
  name: 'Tokyo Night',
  kind: 'dark',
  accent: '#7AA2F7',
  tokens: {
    canvas: '#16161E', base: '#1A1B26', pane: '#1F2335', elevated: '#24283B', hover: '#292E42', border: '#3B4261',
    'text-primary': '#C0CAF5', 'text-secondary': '#A9B1D6', 'text-tertiary': '#737AA2',
    red: '#F7768E', orange: '#FF9E64', yellow: '#E0AF68', green: '#9ECE6A', cyan: '#7DCFFF', blue: '#7AA2F7', purple: '#BB9AF7', pink: '#FF007C',
    'syntax-bg': '#16161E', 'syntax-text': '#C0CAF5', 'syntax-comment': '#565F89', 'syntax-keyword': '#BB9AF7', 'syntax-tag': '#F7768E',
    'syntax-literal': '#FF9E64', 'syntax-string': '#9ECE6A', 'syntax-number': '#FF9E64', 'syntax-function': '#7AA2F7', 'syntax-class': '#2AC3DE',
  },
  terminal: {
    background: '#1A1B26', foreground: '#C0CAF5', cursor: '#C0CAF5', selectionBackground: 'rgba(40,52,87,.9)',
    black: '#15161E', red: '#F7768E', green: '#9ECE6A', yellow: '#E0AF68', blue: '#7AA2F7', magenta: '#BB9AF7', cyan: '#7DCFFF', white: '#A9B1D6',
    brightBlack: '#414868', brightRed: '#F7768E', brightGreen: '#9ECE6A', brightYellow: '#E0AF68',
    brightBlue: '#7AA2F7', brightMagenta: '#BB9AF7', brightCyan: '#7DCFFF', brightWhite: '#C0CAF5',
  },
};
