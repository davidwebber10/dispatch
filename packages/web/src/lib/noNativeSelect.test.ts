import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// No native <select> (2026-11-07): a native select looks different on every OS, ignores the theme,
// and on a phone opens the system wheel. Form fields use components/common/Select (`d.ui.Select`
// in a plugin); filters use components/common/FilterBar (`d.ui.FilterBar`). This walks the app and
// the bundled plugins; comments may name the element.
const WEB = path.resolve(__dirname, '..');
const PLUGINS = path.resolve(__dirname, '../../../plugins');
const SELECT = /<select\b|\bh\(\s*['"`]select['"`]|createElement\(\s*['"`]select['"`]/;

const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\\w])\/\/.*$/gm, '$1');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'test' && e.name !== 'dist') walk(p, out); continue; }
    if (/\.(tsx?|jsx?|mjs)$/.test(e.name) && !/\.test\.[jt]sx?$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('no native <select>', () => {
  it('no source file in packages/web/src or packages/plugins renders a native select', () => {
    const files = [...walk(WEB), ...walk(PLUGINS)];
    expect(files.some((f) => f.includes(`${path.sep}plugins${path.sep}previews${path.sep}`))).toBe(true); // the walk reaches the plugins
    expect(files.length).toBeGreaterThan(100);
    const offenders = files.filter((f) => SELECT.test(stripComments(fs.readFileSync(f, 'utf8')))).map((f) => path.relative(path.resolve(WEB, '../..'), f));
    expect(offenders).toEqual([]);
  });
});
