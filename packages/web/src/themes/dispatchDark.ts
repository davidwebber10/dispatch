import type { Theme } from './types';

/** The original Dispatch look. theme.css :root holds the same values (themes.test.ts checks). */
export const dispatchDark: Theme = {
  id: 'dispatch-dark',
  name: 'Dispatch Dark',
  kind: 'dark',
  accent: '#3ECF6A',
  tokens: {
    canvas: '#08080A', base: '#0F0F11', pane: '#141416', terminal: '#1E1E1E',
    elevated: '#1B1B1E', modal: '#18181B', hover: '#26262B', selected: '#2A2A31',
    border: '#29292E', 'border-strong': '#2C2C32', 'border-hover': '#36363C',
    'on-accent': '#08240F',
    'text-emphasis': '#FFFFFF', 'text-primary': '#E9E9EC', 'text-body': '#C9C9CF', 'text-muted': '#A8A8B0',
    // Tertiary was #5A5A61 before themes; it is a step lighter so it reaches 3:1 on every surface.
    'text-secondary': '#8E8E96', 'text-dim': '#6A6A72', 'text-tertiary': '#68686F', 'text-faint': '#46464D',
    'status-green': '#3ECF6A', 'status-yellow': '#F5C542', 'status-amber': '#E8B04B', 'status-red': '#F0616D',
    'status-coral': '#F37165', 'status-blue': '#5A8DD6', 'on-danger': '#2A0A07',
    red: '#E06C75', orange: '#D19A66', yellow: '#E5C07B', green: '#7FBE6E',
    cyan: '#56B6C2', blue: '#4F90D0', purple: '#C792EA', pink: '#FF6AC1',
    'chart-1': '#3987E5', 'chart-2': '#D95926', 'chart-3': '#199E70', 'chart-4': '#C98500', 'chart-5': '#D55181', 'chart-other': '#6B6B73',
    overlay: 'rgba(0,0,0,.55)', shadow: 'rgba(0,0,0,.5)', 'shadow-strong': 'rgba(0,0,0,.85)',
    'code-bg': '#1B1B1E',
    'syntax-bg': '#282C34', 'syntax-text': '#ABB2BF', 'syntax-comment': '#5C6370', 'syntax-keyword': '#C678DD', 'syntax-tag': '#E06C75',
    'syntax-literal': '#56B6C2', 'syntax-string': '#98C379', 'syntax-number': '#D19A66', 'syntax-function': '#61AEEE', 'syntax-class': '#E6C07B',
  },
  // xterm's built-in palette, which the terminal used before themes.
  terminal: {
    background: '#1E1E1E', foreground: '#FFFFFF', cursor: '#FFFFFF', selectionBackground: 'rgba(255,255,255,.3)',
    black: '#2E3436', red: '#CC0000', green: '#4E9A06', yellow: '#C4A000', blue: '#3465A4', magenta: '#75507B', cyan: '#06989A', white: '#D3D7CF',
    brightBlack: '#555753', brightRed: '#EF2929', brightGreen: '#8AE234', brightYellow: '#FCE94F',
    brightBlue: '#729FCF', brightMagenta: '#AD7FA8', brightCyan: '#34E2E2', brightWhite: '#EEEEEC',
  },
};
