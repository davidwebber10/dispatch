import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FONT_SIZES, fontVar, fontVarInput } from './fontSize';

const css = readFileSync(resolve(__dirname, '../theme.css'), 'utf8');
/** Every `--fs-N:<value>` declared in theme.css, as [N, value]. */
const declared = [...css.matchAll(/--fs-(\d+(?:-\d+)?):\s*([^;]+);/g)].map((m) => [Number(m[1].replace('-', '.')), m[2].trim()] as const);

describe('fontVar', () => {
  test('known size maps to its variable', () => expect(fontVar(12.5)).toBe('var(--fs-12-5)'));
  test('integer size maps to its variable', () => expect(fontVar(13)).toBe('var(--fs-13)'));
  test('unknown size maps to the same size in rem', () => expect(fontVar(17.55)).toBe('1.096875rem'));
  test('fontVarInput never goes below 16px', () => expect(fontVarInput(16)).toBe('max(16px, var(--fs-16))'));
});

describe('--fs-N variables in theme.css', () => {
  test('each one equals N/16 rem', () => {
    expect(declared.length).toBeGreaterThan(0);
    for (const [n, value] of declared) expect(value).toBe(`${n / 16}rem`);
  });
  test('FONT_SIZES and the declared variables are the same set', () => {
    expect(declared.map(([n]) => n).sort((a, b) => a - b)).toEqual([...FONT_SIZES].sort((a, b) => a - b));
  });
  test('each variable is declared once', () => {
    expect(new Set(declared.map(([n]) => n)).size).toBe(declared.length);
  });
  test('<html> font-size is 16px, so 100% is the old pixel size', () => {
    expect(css).toMatch(/(^|\n)html \{ font-size: 16px; \}/);
  });
});
