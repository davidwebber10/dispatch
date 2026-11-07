import type { Theme } from './types';

/** Atom's One Dark palette; terminal colors from One Dark Pro. */
export const oneDark: Theme = {
  id: 'one-dark',
  name: 'One Dark',
  kind: 'dark',
  accent: '#61AFEF',
  tokens: {
    canvas: '#1B1D23', base: '#21252B', pane: '#282C34', elevated: '#2C313A', hover: '#333842', border: '#3E4451',
    'text-primary': '#D7DAE0', 'text-secondary': '#ABB2BF', 'text-tertiary': '#828997',
    red: '#E06C75', orange: '#D19A66', yellow: '#E5C07B', green: '#98C379', cyan: '#56B6C2', blue: '#61AFEF', purple: '#C678DD', pink: '#DE73FF',
    'syntax-bg': '#21252B', 'syntax-text': '#ABB2BF', 'syntax-comment': '#7F848E', 'syntax-keyword': '#C678DD', 'syntax-tag': '#E06C75',
    'syntax-literal': '#56B6C2', 'syntax-string': '#98C379', 'syntax-number': '#D19A66', 'syntax-function': '#61AFEF', 'syntax-class': '#E5C07B',
  },
  terminal: {
    background: '#282C34', foreground: '#ABB2BF', cursor: '#528BFF', selectionBackground: 'rgba(103,118,150,.4)',
    black: '#3F4451', red: '#E05561', green: '#8CC265', yellow: '#D18F52', blue: '#4AA5F0', magenta: '#C162DE', cyan: '#42B3C2', white: '#D7DAE0',
    brightBlack: '#4F5666', brightRed: '#FF616E', brightGreen: '#A5E075', brightYellow: '#F0A45D',
    brightBlue: '#4DC4FF', brightMagenta: '#DE73FF', brightCyan: '#4CD1E0', brightWhite: '#E6E6E6',
  },
};
