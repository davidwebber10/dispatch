import type { Theme } from './types';

/** The Nord palette (nordtheme.com): Polar Night surfaces, Snow Storm text, Frost and Aurora colors. */
export const nord: Theme = {
  id: 'nord',
  name: 'Nord',
  kind: 'dark',
  accent: '#88C0D0',
  tokens: {
    canvas: '#272C36', base: '#2E3440', pane: '#3B4252', elevated: '#434C5E', hover: '#4C566A', border: '#4C566A',
    'text-primary': '#ECEFF4', 'text-secondary': '#D8DEE9', 'text-tertiary': '#AAB3C4',
    red: '#BF616A', orange: '#D08770', yellow: '#EBCB8B', green: '#A3BE8C', cyan: '#88C0D0', blue: '#81A1C1', purple: '#B48EAD', pink: '#B48EAD',
    'syntax-bg': '#2E3440', 'syntax-text': '#D8DEE9', 'syntax-comment': '#7B88A1', 'syntax-keyword': '#81A1C1', 'syntax-tag': '#81A1C1',
    'syntax-literal': '#81A1C1', 'syntax-string': '#A3BE8C', 'syntax-number': '#B48EAD', 'syntax-function': '#88C0D0', 'syntax-class': '#8FBCBB',
  },
  terminal: {
    background: '#2E3440', foreground: '#D8DEE9', cursor: '#D8DEE9', selectionBackground: 'rgba(67,76,94,.8)',
    black: '#3B4252', red: '#BF616A', green: '#A3BE8C', yellow: '#EBCB8B', blue: '#81A1C1', magenta: '#B48EAD', cyan: '#88C0D0', white: '#E5E9F0',
    brightBlack: '#4C566A', brightRed: '#BF616A', brightGreen: '#A3BE8C', brightYellow: '#EBCB8B',
    brightBlue: '#81A1C1', brightMagenta: '#B48EAD', brightCyan: '#8FBCBB', brightWhite: '#ECEFF4',
  },
};
