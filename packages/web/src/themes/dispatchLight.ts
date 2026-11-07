import type { Theme } from './types';

/**
 * Dispatch on a light background: the same layering (a gray canvas, white panes, a quiet border)
 * and the same green accent, darkened so text and links in it keep 4.5:1 on white.
 */
export const dispatchLight: Theme = {
  id: 'dispatch-light',
  name: 'Dispatch Light',
  kind: 'light',
  accent: '#15803D',
  tokens: {
    canvas: '#ECECEF', base: '#F7F7F8', pane: '#FFFFFF', terminal: '#FFFFFF',
    elevated: '#F3F3F5', modal: '#FFFFFF', hover: '#EAEAED', selected: '#E3E3E8',
    border: '#E1E1E5', 'border-strong': '#D6D6DC', 'border-hover': '#C4C4CC',
    'on-accent': '#FFFFFF',
    'text-emphasis': '#000000', 'text-primary': '#18181B', 'text-body': '#2E2E33', 'text-muted': '#45454C',
    'text-secondary': '#5C5C64', 'text-dim': '#6E6E76', 'text-tertiary': '#7A7A82', 'text-faint': '#A3A3AB',
    'status-green': '#15803D', 'status-yellow': '#A16207', 'status-amber': '#B45309', 'status-red': '#D12E3E',
    'status-coral': '#D9443A', 'status-blue': '#2F6CC4', 'on-danger': '#FFFFFF',
    red: '#C2334A', orange: '#B5591A', yellow: '#946200', green: '#2F7D32',
    cyan: '#0E7C86', blue: '#2F6CC4', purple: '#7E4CC8', pink: '#BE3584',
    'chart-1': '#2F6CC4', 'chart-2': '#C2551F', 'chart-3': '#13855E', 'chart-4': '#A66E00', 'chart-5': '#BE3584', 'chart-other': '#8A8A92',
    overlay: 'rgba(15,15,20,.32)', shadow: 'rgba(15,15,20,.12)', 'shadow-strong': 'rgba(15,15,20,.22)',
    'code-bg': '#F3F3F5',
    'syntax-bg': '#F6F7F9', 'syntax-text': '#24292F', 'syntax-comment': '#6E7781', 'syntax-keyword': '#CF222E', 'syntax-tag': '#116329',
    'syntax-literal': '#0550AE', 'syntax-string': '#0A3069', 'syntax-number': '#0550AE', 'syntax-function': '#8250DF', 'syntax-class': '#953800',
  },
  terminal: {
    background: '#FFFFFF', foreground: '#1F1F23', cursor: '#18181B', cursorAccent: '#FFFFFF', selectionBackground: 'rgba(21,128,61,.2)',
    black: '#1F1F23', red: '#C62F3E', green: '#2E7D32', yellow: '#8A6100', blue: '#2F62C4', magenta: '#8A4FD0', cyan: '#0F7F8A', white: '#8E8E96',
    brightBlack: '#5C5C64', brightRed: '#E0424F', brightGreen: '#3C9A40', brightYellow: '#A67C00',
    brightBlue: '#3D7BE0', brightMagenta: '#A066E0', brightCyan: '#1497A3', brightWhite: '#B4B4BC',
  },
};
