import type { Theme } from './types';

/**
 * POLYWOOD OS Light and Dark: Dispatch painted with the design tokens of Polywood OS, so a hosted
 * workspace looks like the rest of OS. Source: explorer `web/src/index.css` (origin/main, the shadcn
 * HSL variables of `:root` and `.dark`), converted to hex.
 *
 * Mapping (Dispatch token ← OS variable):
 *   canvas, base ← --background         pane ← --card              modal ← --popover
 *   elevated ← --muted (light) / --popover (dark)                  hover ← --secondary / --accent
 *   border ← --border                   border-hover ← --input
 *   text-primary ← --foreground         text-secondary ← --muted-foreground (light: one step darker, see below)
 *   accent ← --primary                  on-accent ← --primary-foreground (dark)
 *   red ← --destructive  orange ← --warning  green ← --success  blue ← --info
 *   chart-1..4 ← --dpc-1..4             cyan, purple, pink ← --dpc-2, --dpc-4, --dpc-cov-hires
 *
 * Gaps (OS has no token; a value was chosen):
 *   - text-tertiary, text-faint, selected, border-strong: derived between the OS values.
 *   - yellow: OS has none; an amber between --warning and --primary.
 *   - Light accent: the OS amber (#F07D19) with white text is 2.7:1 and as link text on white it is
 *     unreadable, so the light accent is the same hue darkened to 4.7:1 (#B65B0C), with white text.
 *     The dark accent is the OS sky blue with the OS --primary-foreground, unchanged.
 *   - Light text-secondary: the OS --muted-foreground is 4.2:1 on --muted; one step darker reaches 4.5:1.
 *   - Syntax colors and the terminal (ANSI) palette: OS has no code or terminal surface. The values
 *     are a quiet palette built from the OS hues on the OS surfaces. A business person has no
 *     terminal, so the terminal palette matters only for developers.
 *   - Fonts: OS sets no font family, so it uses the Tailwind default (the system UI font and the
 *     system monospace font). Radius: OS --radius is 10px; Dispatch's lg (cards, popovers) becomes
 *     10px, the rest of the scale stays.
 */
const OS_VARS = {
  '--font-sans': 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  '--font-mono': 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  '--radius-lg': '10px',
};

export const osLight: Theme = {
  id: 'os-light',
  name: 'POLYWOOD OS Light',
  kind: 'light',
  accent: '#B65B0C',
  vars: OS_VARS,
  tokens: {
    canvas: '#F8F6F2', base: '#F8F6F2', pane: '#FFFFFF', modal: '#FFFFFF',
    elevated: '#EEEBE7', hover: '#EBE6E0', selected: '#E4DED6',
    border: '#E1DCD6', 'border-strong': '#DAD4CD', 'border-hover': '#D4CDC4',
    'on-accent': '#FFFFFF',
    'text-emphasis': '#000000', 'text-primary': '#29231E', 'text-secondary': '#6A625A', 'text-tertiary': '#847A71',
    red: '#DF3020', orange: '#C2620A', yellow: '#A66E00', green: '#2E8A54',
    cyan: '#0F766E', blue: '#1D73ED', purple: '#7C3AED', pink: '#E11D48',
    'status-red': '#DF3020', 'status-green': '#2E8A54', 'status-blue': '#1D73ED', 'status-yellow': '#A66E00', 'status-amber': '#F58C14',
    'chart-1': '#3B82F6', 'chart-2': '#14B8A6', 'chart-3': '#F59E0B', 'chart-4': '#A78BFA', 'chart-5': '#FB7185',
    overlay: 'rgba(41,35,30,.32)', shadow: 'rgba(41,35,30,.12)', 'shadow-strong': 'rgba(41,35,30,.22)',
    'code-bg': '#EFECE6',
    'syntax-bg': '#F4F1EC', 'syntax-text': '#29231E', 'syntax-comment': '#7A7068', 'syntax-keyword': '#B4261A', 'syntax-tag': '#2E7D4F',
    'syntax-literal': '#1D5FC4', 'syntax-string': '#0F6B64', 'syntax-number': '#A3530A', 'syntax-function': '#6D35D0', 'syntax-class': '#8A5A00',
  },
  terminal: {
    background: '#FFFFFF', foreground: '#29231E', cursor: '#29231E', cursorAccent: '#FFFFFF', selectionBackground: 'rgba(240,125,25,.22)',
    black: '#29231E', red: '#C42B1D', green: '#2E7D4F', yellow: '#8F6200', blue: '#1D63D0', magenta: '#7C3AED', cyan: '#0F766E', white: '#8A8178',
    brightBlack: '#6A625A', brightRed: '#DF3020', brightGreen: '#2E8A54', brightYellow: '#A66E00',
    brightBlue: '#1D73ED', brightMagenta: '#9061F0', brightCyan: '#139488', brightWhite: '#B3AAA1',
  },
};

export const osDark: Theme = {
  id: 'os-dark',
  name: 'POLYWOOD OS Dark',
  kind: 'dark',
  accent: '#5598F6',
  vars: OS_VARS,
  tokens: {
    canvas: '#0E0D0C', base: '#0E0D0C', pane: '#161413', modal: '#1E1C1A',
    elevated: '#1E1C1A', hover: '#2E2B29', selected: '#33302D',
    border: '#2B2927', 'border-strong': '#33302D', 'border-hover': '#4C4743',
    'on-accent': '#0D1726',
    'text-emphasis': '#FFFFFF', 'text-primary': '#EEEBE7', 'text-secondary': '#A19A91', 'text-tertiary': '#847B71',
    red: '#ED6A5E', orange: '#F3A83F', yellow: '#E8C060', green: '#66CC99',
    cyan: '#2DD4BF', blue: '#5598F6', purple: '#A78BFA', pink: '#FB7185',
    'status-red': '#ED6A5E', 'status-green': '#66CC99', 'status-blue': '#5598F6', 'status-yellow': '#E8C060', 'status-amber': '#F3A83F',
    'chart-1': '#2563EB', 'chart-2': '#0D9488', 'chart-3': '#D97706', 'chart-4': '#8B5CF6', 'chart-5': '#F43F5E',
    overlay: 'rgba(0,0,0,.55)', shadow: 'rgba(0,0,0,.5)', 'shadow-strong': 'rgba(0,0,0,.85)',
    'code-bg': '#1E1C1A',
    'syntax-bg': '#1A1817', 'syntax-text': '#E2DED8', 'syntax-comment': '#8A8177', 'syntax-keyword': '#F08A80', 'syntax-tag': '#66CC99',
    'syntax-literal': '#7FB0F8', 'syntax-string': '#5EDDC9', 'syntax-number': '#F3A83F', 'syntax-function': '#B9A3FB', 'syntax-class': '#E8C060',
  },
  terminal: {
    background: '#161413', foreground: '#EEEBE7', cursor: '#EEEBE7', cursorAccent: '#161413', selectionBackground: 'rgba(85,152,246,.3)',
    black: '#2E2B29', red: '#ED6A5E', green: '#66CC99', yellow: '#E8C060', blue: '#5598F6', magenta: '#A78BFA', cyan: '#2DD4BF', white: '#D4CFC8',
    brightBlack: '#6E665E', brightRed: '#F3897F', brightGreen: '#85D9AE', brightYellow: '#F0D07E',
    brightBlue: '#7FB0F8', brightMagenta: '#BFA9FC', brightCyan: '#5EDDC9', brightWhite: '#F6F4F1',
  },
};
