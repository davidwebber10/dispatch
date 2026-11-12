import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { dispatchDark } from '../../themes/dispatchDark';

// Guards for the tokens and the primitives' stylesheet (engineering program 2026-11-09, W3-E).
const theme = fs.readFileSync(path.resolve(__dirname, '../../theme.css'), 'utf8');
const ui = fs.readFileSync(path.resolve(__dirname, 'ui.css'), 'utf8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const token = (name: string) => stripComments(theme).match(new RegExp(`${name}:\\s*([^;]+);`))?.[1].trim();

describe('scale tokens (theme.css)', () => {
  it('has a type scale of six steps, each larger than the one before', () => {
    // Each step is a text-scale variable `var(--fs-N)`: N px at 100% (lib/fontSize.ts).
    const steps = ['--text-xs', '--text-sm', '--text-base', '--text-md', '--text-lg', '--text-xl'].map((t) => token(t));
    for (const s of steps) expect(s).toMatch(/^var\(--fs-\d+(-\d+)?\)$/);
    const px = steps.map((s) => parseFloat(s!.slice('var(--fs-'.length).replace('-', '.')));
    expect([...px].sort((a, b) => a - b)).toEqual(px);
    expect(new Set(px).size).toBe(6);
  });

  it('has a space scale of eight steps, each larger than the one before', () => {
    const px = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => parseFloat(token(`--space-${n}`) ?? 'NaN'));
    expect(px.every((n) => Number.isFinite(n))).toBe(true);
    expect([...px].sort((a, b) => a - b)).toEqual(px);
    expect(new Set(px).size).toBe(8);
  });

  it('has a layer scale of six steps in stacking order', () => {
    // A dropdown must open above the dialog that holds it, and a confirm dialog above both.
    const order = ['--z-base', '--z-sticky', '--z-overlay', '--z-dropdown', '--z-modal', '--z-toast'];
    const z = order.map((t) => Number(token(t)));
    expect(z.every((n) => Number.isInteger(n))).toBe(true);
    expect([...z].sort((a, b) => a - b)).toEqual(z);
    expect(new Set(z).size).toBe(6);
  });

  it('did not change a color token: theme.css still matches the Dispatch Dark theme', () => {
    for (const [name, value] of Object.entries(dispatchDark.tokens)) {
      if (!name.startsWith('--color-')) continue;
      expect(token(name)?.toLowerCase(), name).toBe(String(value).toLowerCase());
    }
  });
});

describe('primitives stylesheet (ui.css)', () => {
  const css = stripComments(ui);

  it('has one global :focus-visible rule, in the accent color', () => {
    // A selector that is `:focus-visible` alone (not `.x:focus-visible`): the keyboard focus ring of the whole app.
    const global = [...css.matchAll(/(^|[{};,\s]):focus-visible\s*{([^}]*)}/g)];
    expect(global).toHaveLength(1);
    expect(global[0][2]).toMatch(/outline:\s*2px solid var\(--color-accent\)/);
    expect(global[0][2]).toMatch(/outline-offset:\s*2px/);
    // No primitive turns the ring off for the keyboard.
    expect(css).not.toMatch(/:focus-visible[^{]*{[^}]*outline:\s*(none|0)\b/);
  });

  it('sets every z-index from a layer token', () => {
    const values = [...css.matchAll(/z-index:\s*([^;]+);/g)].map((m) => m[1].trim());
    expect(values.length).toBeGreaterThan(0);
    for (const v of values) expect(v).toMatch(/^var\(--z-[a-z]+\)$/);
  });

  it('takes every color from a token', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/\b(rgb|rgba|hsl|hsla)\(/);
  });

  it('takes every radius from the radius scale', () => {
    const values = [...css.matchAll(/border-radius:\s*([^;]+);/g)].map((m) => m[1].trim());
    for (const v of values) expect(v).toMatch(/^(var\(--radius-[\w]+\)|50%|0)$/);
  });
});
