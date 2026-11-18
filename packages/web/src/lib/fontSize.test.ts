import { describe, test, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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

// A fixed pixel font size does not follow the text scale, and nobody sees that at 100%. This scan keeps
// the feature complete: new code must use fontVar() / fontVarInput() (or var(--fs-N) in CSS, rem in a
// bundled plugin). 2026-11-18: six days of work on main had added 32 such lines before this test.
describe('no fixed pixel font size', () => {
  const SRC = resolve(__dirname, '..');
  const PLUGINS = resolve(__dirname, '../../../plugins');
  /** Text in a fixed-size box (an icon badge, a usage ring): it must NOT grow, so it stays in px. */
  const ALLOWED_FILES = ['components/common/FileIcon.tsx', 'components/layout/UsageChip.tsx'];
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(p);
    return /\.(tsx?|css)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
  const files = [
    ...walk(SRC).filter((f) => !ALLOWED_FILES.some((a) => f.endsWith(a))),
    ...readdirSync(PLUGINS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(PLUGINS, e.name, 'web.js')).filter((f) => existsSync(f)),
  ];
  const RULES: [string, RegExp][] = [
    // fontSize: 13   (a number times the text scale is fine: a chart or a canvas needs a number)
    ['fontSize: <number>', /\bfontSize:\s*\d+(\.\d+)?(?!\s*\*\s*textScale)(?=\s*[,}\n)]|\s*$)/],
    // fontSize: phone ? 15 : 13
    ['fontSize: a ? <number> : <number>', /\bfontSize:\s*[\w.!]+\s*\?\s*\d+(\.\d+)?\s*:\s*\d+(\.\d+)?(?=\s*[,}\n)])/],
    // font: '600 12px var(--font-sans)' and font: `500 ${m ? 14 : 12}px ...` (a line height after "/" may stay in px)
    ['font shorthand with a px size', /\bfont:\s*['"`][^'"`\n]*?(?<![/\w.])(\d+(\.\d+)?|\$\{[^}]*\})px/],
    // CSS: font-size: 14px; font: 400 12px/18px ...
    ['CSS font size in px', /(?:^|[;{\s])font(?:-size)?:\s*[^;}\n]*?(?<![/\w.-])\d+(\.\d+)?px/],
  ];
  test('the scan finds the files', () => {
    expect(files.length).toBeGreaterThan(300);
    expect(files.some((f) => f.endsWith(join('plugins', 'previews', 'web.js')))).toBe(true);
  });
  test('the rules catch each fixed form, and let the scaled forms pass', () => {
    const hit = (line: string) => RULES.some(([, re]) => re.test(line));
    for (const bad of ["{ fontSize: 13, color: 'red' }", '{ fontSize: 12.5 }', '{ fontSize: phone ? 15 : 13 }', "font: '600 12px var(--font-sans)'", 'font: `500 ${m ? 14 : 12}px var(--font-mono)`', "font: '13px/1.5 var(--font-mono)'", '.x { font-size: 14px; }', '.x { font: 400 12px/18px var(--font-mono); }'])
      expect(hit(bad), bad).toBe(true);
    for (const ok of ['{ fontSize: fontVar(13) }', '{ fontSize: fontVar(phone ? 15 : 13) }', '{ fontSize: 11 * textScale }', 'font: `600 ${fontVar(12)} var(--font-sans)`', 'font: `600 ${fontVar(13)}/30px var(--font-mono)`', '{ fontSize: rem(13) }', '.x { font: 400 var(--fs-12)/18px var(--font-mono); }', '.x { font-size: var(--fs-14); line-height: 20px; }', "font: 'inherit'"])
      expect(hit(ok), ok).toBe(false);
  });
  test('no source file sets a font size in fixed pixels', () => {
    const found: string[] = [];
    for (const f of files) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        // The one fixed size: the base that the scale multiplies (theme.css).
        if (/^html \{ font-size: 16px; \}/.test(line)) return;
        for (const [name, re] of RULES) if (re.test(line)) found.push(`${f.replace(SRC, 'src').replace(PLUGINS, 'plugins')}:${i + 1} (${name})`);
      });
    }
    expect(found, `use fontVar() from lib/fontSize.ts (rem in a bundled plugin):\n${found.join('\n')}`).toEqual([]);
  });
});
