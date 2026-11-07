/// <reference types="vite/client" />
import { describe, it, expect } from 'vitest';
import { THEMES, resolveTokens, cssVarName, termVarName, themeFor, dispatchDark, dispatchLight } from './index';
import { contrast, parseColor } from './color';
import type { TerminalPalette, TokenName } from './types';
import fs from 'node:fs';
import path from 'node:path';

const themeCss = fs.readFileSync(path.resolve(__dirname, '../theme.css'), 'utf8');

// Text sits on these surfaces. WCAG AA: 4.5:1 for body text, 3:1 for the tertiary (large / non-essential) text.
const SURFACES = ['canvas', 'base', 'pane', 'elevated', 'modal'] as const;
const NEEDS: Array<[TokenName, number]> = [['text-primary', 4.5], ['text-secondary', 4.5], ['text-tertiary', 3]];

describe('theme registry', () => {
  it('has the twelve themes, unique ids, light ones before dark ones', () => {
    expect(THEMES.map((t) => t.name)).toEqual([
      'Dispatch Light', 'GitHub Light', 'Solarized Light', 'Catppuccin Latte',
      'Dispatch Dark', 'GitHub Dark', 'One Dark', 'Dracula', 'Nord', 'Solarized Dark', 'Catppuccin Mocha', 'Tokyo Night',
    ]);
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(THEMES.length);
    const kinds = THEMES.map((t) => t.kind);
    expect(kinds.lastIndexOf('light')).toBeLessThan(kinds.indexOf('dark'));
  });

  it('every token and terminal color of every theme is a valid color', () => {
    for (const t of THEMES) {
      for (const [k, v] of Object.entries(resolveTokens(t))) expect(() => parseColor(v), `${t.id} ${k}`).not.toThrow();
      for (const [k, v] of Object.entries(t.terminal)) expect(() => parseColor(v), `${t.id} terminal ${k}`).not.toThrow();
    }
  });

  for (const theme of THEMES) {
    it(`${theme.name}: text contrast on every surface (primary/secondary ≥ 4.5, tertiary ≥ 3)`, () => {
      const tk = resolveTokens(theme);
      const fails: string[] = [];
      for (const [text, min] of NEEDS) {
        for (const s of SURFACES) {
          const r = contrast(tk[text], tk[s]);
          if (r < min) fails.push(`${text} ${tk[text]} on ${s} ${tk[s]}: ${r.toFixed(2)} < ${min}`);
        }
      }
      expect(fails).toEqual([]);
    });

    it(`${theme.name}: text on the accent and the terminal foreground are readable`, () => {
      const tk = resolveTokens(theme);
      expect(contrast(tk['on-accent'], tk.accent)).toBeGreaterThanOrEqual(3);
      expect(contrast(theme.terminal.foreground, theme.terminal.background)).toBeGreaterThanOrEqual(4.5);
    });
  }

  it('theme.css :root holds the Dispatch Dark values, so the first paint matches the default theme', () => {
    const root = themeCss.slice(0, themeCss.indexOf('}'));
    const tk = resolveTokens(dispatchDark);
    const missing: string[] = [];
    for (const [k, v] of Object.entries(tk)) {
      const m = new RegExp(`${cssVarName(k as TokenName)}:\\s*([^;]+);`).exec(root);
      if (!m || m[1].trim().toLowerCase() !== v.toLowerCase()) missing.push(`${cssVarName(k as TokenName)} css=${m?.[1]} theme=${v}`);
    }
    for (const [k, v] of Object.entries(dispatchDark.terminal)) {
      const name = termVarName(k as keyof TerminalPalette);
      const m = new RegExp(`${name}:\\s*([^;]+);`).exec(root);
      if (!m || m[1].trim().toLowerCase() !== v.toLowerCase()) missing.push(`${name} css=${m?.[1]} theme=${v}`);
    }
    expect(missing).toEqual([]);
  });

  it("'system' picks Dispatch Light or Dark; an unknown id falls back to Dispatch Dark", () => {
    expect(themeFor('system', true).id).toBe(dispatchDark.id);
    expect(themeFor('system', false).id).toBe(dispatchLight.id);
    expect(themeFor('nord', false).id).toBe('nord');
    expect(themeFor('no-such-theme', false).id).toBe(dispatchDark.id);
  });
});
