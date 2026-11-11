import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// No accent lines on the left edge of a card, callout, quote or block (owner, 2026-11-11: "get rid of
// those left lines on the things, that is so AI obvious"). A 1px border between two panes or two
// segments is a divider, not a rail, and stays allowed. A rail is a left border of 2px or more, or a
// left inset shadow used as one.
const ROOTS = [path.resolve(__dirname, '..'), path.resolve(__dirname, '../../../plugins')];
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\\w])\/\/.*$/gm, '$1');
function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'dist') walk(p, out); continue; }
    if (/\.(tsx?|jsx?|mjs|css)$/.test(e.name) && !/\.test\.[jt]sx?$/.test(e.name)) out.push(p);
  }
  return out;
}
const RAIL = [
  /borderLeft(?:Width)?\s*:\s*['"`]?\s*(?:[2-9]|\d{2,})px/,
  /border-left(?:-width)?\s*:\s*(?:[2-9]|\d{2,})px/,
  /borderInlineStart\s*:\s*['"`]?\s*(?:[2-9]|\d{2,})px/,
  /border-inline-start\s*:\s*(?:[2-9]|\d{2,})px/,
  /inset\s+(?:[2-9]|\d{2,})px\s+0(?:px)?\s+0/,
];

describe('no left rails', () => {
  it('no card, callout, quote or block has an accent line on its left edge', () => {
    const offenders: string[] = [];
    for (const root of ROOTS) for (const f of walk(root)) {
      const src = stripComments(fs.readFileSync(f, 'utf8'));
      src.split('\n').forEach((line, i) => { if (RAIL.some((r) => r.test(line))) offenders.push(`${path.relative(root, f)}:${i + 1}`); });
    }
    expect(offenders).toEqual([]);
  });
});
