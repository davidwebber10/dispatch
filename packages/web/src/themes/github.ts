import type { Theme } from './types';

/** GitHub's Primer palettes (light and dark default), and the terminal colors of GitHub's VS Code themes. */
export const githubLight: Theme = {
  id: 'github-light',
  name: 'GitHub Light',
  kind: 'light',
  accent: '#0969DA',
  tokens: {
    canvas: '#F6F8FA', base: '#FFFFFF', pane: '#FFFFFF', elevated: '#F6F8FA', hover: '#EFF2F5', border: '#D1D9E0',
    'text-primary': '#1F2328', 'text-secondary': '#59636E', 'text-tertiary': '#818B98',
    red: '#D1242F', orange: '#BC4C00', yellow: '#9A6700', green: '#1A7F37', cyan: '#1B7C83', blue: '#0969DA', purple: '#8250DF', pink: '#BF3989',
    'syntax-bg': '#F6F8FA', 'syntax-text': '#1F2328', 'syntax-comment': '#59636E', 'syntax-keyword': '#CF222E', 'syntax-tag': '#116329',
    'syntax-literal': '#0550AE', 'syntax-string': '#0A3069', 'syntax-number': '#0550AE', 'syntax-function': '#8250DF', 'syntax-class': '#953800',
  },
  terminal: {
    background: '#FFFFFF', foreground: '#1F2328', cursor: '#0969DA', selectionBackground: 'rgba(9,105,218,.2)',
    black: '#24292F', red: '#CF222E', green: '#116329', yellow: '#4D2D00', blue: '#0969DA', magenta: '#8250DF', cyan: '#1B7C83', white: '#6E7781',
    brightBlack: '#57606A', brightRed: '#A40E26', brightGreen: '#1A7F37', brightYellow: '#633C01',
    brightBlue: '#218BFF', brightMagenta: '#A475F9', brightCyan: '#3192AA', brightWhite: '#8C959F',
  },
};

export const githubDark: Theme = {
  id: 'github-dark',
  name: 'GitHub Dark',
  kind: 'dark',
  accent: '#4493F8',
  tokens: {
    canvas: '#010409', base: '#0D1117', pane: '#151B23', elevated: '#212830', hover: '#262C36', border: '#3D444D',
    'text-primary': '#F0F6FC', 'text-secondary': '#9198A1', 'text-tertiary': '#7D8590',
    red: '#F85149', orange: '#DB6D28', yellow: '#D29922', green: '#3FB950', cyan: '#39C5CF', blue: '#4493F8', purple: '#AB7DF8', pink: '#DB61A2',
    'syntax-bg': '#151B23', 'syntax-text': '#F0F6FC', 'syntax-comment': '#9198A1', 'syntax-keyword': '#FF7B72', 'syntax-tag': '#7EE787',
    'syntax-literal': '#79C0FF', 'syntax-string': '#A5D6FF', 'syntax-number': '#79C0FF', 'syntax-function': '#D2A8FF', 'syntax-class': '#FFA657',
  },
  terminal: {
    background: '#0D1117', foreground: '#E6EDF3', cursor: '#2F81F7', selectionBackground: 'rgba(56,139,253,.3)',
    black: '#484F58', red: '#FF7B72', green: '#3FB950', yellow: '#D29922', blue: '#58A6FF', magenta: '#BC8CFF', cyan: '#39C5CF', white: '#B1BAC4',
    brightBlack: '#6E7681', brightRed: '#FFA198', brightGreen: '#56D364', brightYellow: '#E3B341',
    brightBlue: '#79C0FF', brightMagenta: '#D2A8FF', brightCyan: '#56D4DD', brightWhite: '#FFFFFF',
  },
};
