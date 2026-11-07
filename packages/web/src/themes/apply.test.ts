import { describe, it, expect, beforeEach } from 'vitest';
import { applyTheme, themeVars, BOOT_KEY, bootPayload } from './apply';
import { getTheme, dispatchDark, dispatchLight, resolveTokens } from './index';

const root = () => document.documentElement;
const v = (name: string) => root().style.getPropertyValue(name);

describe('applying a theme', () => {
  beforeEach(() => {
    root().removeAttribute('style');
    root().removeAttribute('data-theme');
    document.head.innerHTML = '<meta name="theme-color" content="#0F0F11">';
    localStorage.clear();
  });

  it('writes every token and terminal color of the theme as CSS variables on <html>', () => {
    const nord = getTheme('nord')!;
    applyTheme(nord, '');
    const tk = resolveTokens(nord);
    expect(v('--color-canvas')).toBe(tk.canvas);
    expect(v('--color-text-primary')).toBe(tk['text-primary']);
    expect(v('--color-accent')).toBe(nord.accent);
    expect(v('--syntax-keyword')).toBe(tk['syntax-keyword']);
    expect(v('--term-bright-cyan')).toBe(nord.terminal.brightCyan);
    expect(v('--term-selection')).toBe(nord.terminal.selectionBackground);
    expect(root().dataset.theme).toBe('nord');
  });

  it('sets color-scheme and the theme-color meta from the theme', () => {
    applyTheme(dispatchLight, '');
    expect(root().style.colorScheme).toBe('light');
    expect(document.querySelector('meta[name="theme-color"]')!.getAttribute('content')).toBe(resolveTokens(dispatchLight).base);
    applyTheme(dispatchDark, '');
    expect(root().style.colorScheme).toBe('dark');
    expect(document.querySelector('meta[name="theme-color"]')!.getAttribute('content')).toBe('#0F0F11');
  });

  it("the user's accent overrides the theme's, and the text on it follows the accent", () => {
    applyTheme(dispatchLight, '#F5C542');
    expect(v('--color-accent')).toBe('#F5C542');
    // A light yellow accent needs dark text, whatever the theme gave.
    expect(v('--color-on-accent')).not.toBe('#FFFFFF');
    applyTheme(dispatchLight, '');
    expect(v('--color-accent')).toBe(dispatchLight.accent);
    expect(v('--color-on-accent')).toBe(resolveTokens(dispatchLight)['on-accent']);
  });

  it('themeVars of Dispatch Dark with no accent override equals the theme as written', () => {
    const vars = themeVars(dispatchDark, '');
    expect(vars['--color-accent']).toBe('#3ECF6A');
    expect(vars['--color-on-accent']).toBe('#08240F');
    expect(vars['--term-background']).toBe('#1E1E1E');
  });

  it('saves a boot payload so the next launch paints the theme before the app loads', () => {
    applyTheme(dispatchLight, '', 'dispatch-light');
    const saved = JSON.parse(localStorage.getItem(BOOT_KEY)!);
    expect(saved.fixed.scheme).toBe('light');
    expect(saved.fixed.vars['--color-canvas']).toBe(resolveTokens(dispatchLight).canvas);
  });

  it("the boot payload for 'system' holds both the light and the dark theme", () => {
    const p = bootPayload('system', '');
    expect(p.fixed).toBeUndefined();
    expect(p.light!.vars['--color-canvas']).toBe(resolveTokens(dispatchLight).canvas);
    expect(p.dark!.vars['--color-canvas']).toBe(resolveTokens(dispatchDark).canvas);
  });
});
