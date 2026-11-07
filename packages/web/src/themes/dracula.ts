import type { Theme } from './types';

/** The Dracula palette (draculatheme.com/contribute). Dracula has no blue; purple stands in, as in its terminal palette. */
export const dracula: Theme = {
  id: 'dracula',
  name: 'Dracula',
  kind: 'dark',
  accent: '#BD93F9',
  tokens: {
    canvas: '#191A21', base: '#21222C', pane: '#282A36', elevated: '#343746', hover: '#44475A', border: '#44475A',
    'text-primary': '#F8F8F2', 'text-secondary': '#B4B8CC', 'text-tertiary': '#8B95C0',
    red: '#FF5555', orange: '#FFB86C', yellow: '#F1FA8C', green: '#50FA7B', cyan: '#8BE9FD', blue: '#BD93F9', purple: '#BD93F9', pink: '#FF79C6',
    'syntax-bg': '#21222C', 'syntax-text': '#F8F8F2', 'syntax-comment': '#6272A4', 'syntax-keyword': '#FF79C6', 'syntax-tag': '#FF79C6',
    'syntax-literal': '#BD93F9', 'syntax-string': '#F1FA8C', 'syntax-number': '#BD93F9', 'syntax-function': '#50FA7B', 'syntax-class': '#8BE9FD',
  },
  terminal: {
    background: '#282A36', foreground: '#F8F8F2', cursor: '#F8F8F2', selectionBackground: 'rgba(68,71,90,.9)',
    black: '#21222C', red: '#FF5555', green: '#50FA7B', yellow: '#F1FA8C', blue: '#BD93F9', magenta: '#FF79C6', cyan: '#8BE9FD', white: '#F8F8F2',
    brightBlack: '#6272A4', brightRed: '#FF6E6E', brightGreen: '#69FF94', brightYellow: '#FFFFA5',
    brightBlue: '#D6ACFF', brightMagenta: '#FF92DF', brightCyan: '#A4FFFF', brightWhite: '#FFFFFF',
  },
};
