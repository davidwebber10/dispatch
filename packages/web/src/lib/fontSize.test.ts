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
  /**
   * Text in a fixed-size box (an icon badge, a usage ring) must NOT grow, so it stays in px. Each file
   * lists how many such lines it has: one more is a failure, so the exception does not spread.
   */
  const ALLOWED: Record<string, number> = { 'components/common/FileIcon.tsx': 1, 'components/layout/UsageChip.tsx': 3 };
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(p);
    return /\.(tsx?|css)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
  const files = [
    ...walk(SRC),
    ...readdirSync(PLUGINS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(PLUGINS, e.name, 'web.js')).filter((f) => existsSync(f)),
  ];
  /** Script rules (ts, tsx, js). Each stays inside one value, so a later `padding: '8px'` on the line is not a hit. */
  const SCRIPT_RULES: [string, RegExp][] = [
    // fontSize: 13   (0 is not a size; a number times the text scale is fine: a chart or a canvas needs a number)
    ['fontSize: <number>', /\bfontSize:\s*(?!0\s*[,})])\d+(\.\d+)?(?!\s*\*\s*textScale)(?=\s*[,}\n)]|\s*$)/],
    // fontSize: phone ? 15 : 13
    ['fontSize: a ? <number> : <number>', /\bfontSize:\s*[\w.!]+\s*\?\s*\d+(\.\d+)?\s*:\s*\d+(\.\d+)?(?=\s*[,}\n)])/],
    // fontSize: '13px'
    ["fontSize: '<number>px'", /\bfontSize:\s*['"`]\d+(\.\d+)?px['"`]/],
    // font: '600 12px var(--font-sans)' and font: `500 ${m ? 14 : 12}px ...` (a line height after "/" may stay in px)
    ['font shorthand with a px size', /\bfont:\s*(['"`])(?:(?!\1).)*?(?<![\w.])(?<!\/\s*)(\d+(\.\d+)?|\$\{[^}]*\})px/],
  ];
  /** The size of a CSS declaration's value: `font-size: V`, or the size part of the `font: V` shorthand (before "/"). */
  const cssHit = (line: string): boolean => {
    for (const m of line.matchAll(/(?:^|[;{\s])(font(?:-size)?)\s*:\s*([^;}]*)/g)) {
      const value = m[2].trim();
      if (m[1] === 'font-size') { if (/^\d+(\.\d+)?px\b/.test(value)) return true; continue; }
      const size = value.replace(/\s*\/\s*/g, '/').split(/\s+/).find((t) => /^(\d|var\(|calc\(|max\()/.test(t) && !/^\d+$/.test(t));
      if (size && /^\d+(\.\d+)?px$/.test(size.split('/')[0])) return true;
    }
    return false;
  };
  /** The file's lines with comments blanked (line and block comments), so a size in a comment is not a hit. */
  const codeLines = (text: string): string[] => text
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
    .split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '$1'));
  const hitsOf = (line: string, css: boolean): string[] => (css
    ? (cssHit(line) ? ['CSS font size in px'] : [])
    : SCRIPT_RULES.filter(([, re]) => re.test(line)).map(([name]) => name));
  const scan = (file: string): string[] => {
    const css = file.endsWith('.css');
    return codeLines(readFileSync(file, 'utf8')).flatMap((line, i) => {
      // The one fixed size: the base that the scale multiplies (theme.css).
      if (css && /^html \{ font-size: 16px; \}/.test(line)) return [];
      return hitsOf(line, css).map((name) => `${file.replace(SRC, 'src').replace(PLUGINS, 'plugins')}:${i + 1} (${name})`);
    });
  };

  test('the scan finds the files', () => {
    expect(files.length).toBeGreaterThan(300);
    expect(files.some((f) => f.endsWith(join('plugins', 'previews', 'web.js')))).toBe(true);
    for (const a of Object.keys(ALLOWED)) expect(files.some((f) => f.endsWith(a)), a).toBe(true);
  });
  test('the script rules catch each fixed form, and let the scaled forms and other code pass', () => {
    const hit = (line: string) => hitsOf(codeLines(line)[0], false).length > 0;
    for (const bad of ["{ fontSize: 13, color: 'red' }", '{ fontSize: 12.5 }', '{ fontSize: phone ? 15 : 13 }', "{ fontSize: '13px' }", "font: '600 12px var(--font-sans)'", 'font: `500 ${m ? 14 : 12}px var(--font-mono)`', "font: '13px/1.5 var(--font-mono)'"])
      expect(hit(bad), bad).toBe(true);
    for (const ok of ['{ fontSize: fontVar(13) }', '{ fontSize: fontVar(phone ? 15 : 13) }', '{ fontSize: 11 * textScale }', '{ fontSize: 0 }', 'font: `600 ${fontVar(12)} var(--font-sans)`', 'font: `600 ${fontVar(13)}/30px var(--font-mono)`', 'font: `600 ${fontVar(13)} / 30px var(--font-mono)`', '{ fontSize: rem(13) }', "{ font: 'inherit', padding: '8px' }", "{ font: 'inherit', fontWeight: 600, borderRadius: `${r}px` }", '// was fontSize: 13, before the text scale', "const x = 1; // font: '600 12px sans'", "{ fontSize: 'inherit' }"])
      expect(hit(ok), ok).toBe(false);
  });
  test('the CSS rule reads one declaration at a time', () => {
    for (const bad of ['.x { font-size: 14px; }', '.x { font: 400 12px/18px var(--font-mono); }', '.x { color: red; font: 12px sans-serif }'])
      expect(cssHit(bad), bad).toBe(true);
    for (const ok of ['.x { font: 400 var(--fs-12)/18px var(--font-mono); }', '.x { font: 400 var(--fs-12)/ 18px sans-serif; }', '.x { font-size: var(--fs-14); line-height: 20px; }', '.x { font: inherit; padding: 8px; }', '.x { font-size: .88em; }', '.x { font-family: var(--font-mono); width: 12px; }', '.x { font-weight: 600; height: 30px; }'])
      expect(cssHit(ok), ok).toBe(false);
  });
  test('no source file sets a font size in fixed pixels', () => {
    const found = files.filter((f) => !Object.keys(ALLOWED).some((a) => f.endsWith(a))).flatMap(scan);
    expect(found, `use fontVar() from lib/fontSize.ts (rem in a bundled plugin):\n${found.join('\n')}`).toEqual([]);
  });
  test('the files with text in a fixed-size box have exactly their known fixed lines', () => {
    for (const [a, count] of Object.entries(ALLOWED)) {
      const found = scan(files.find((f) => f.endsWith(a))!);
      expect(found, `${a}: a fixed size is allowed only for text in a fixed-size box. If this one is, raise the count:\n${found.join('\n')}`).toHaveLength(count);
    }
  });
});
