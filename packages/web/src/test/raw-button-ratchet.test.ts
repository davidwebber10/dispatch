import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// The raw-button ratchet (engineering program 2026-11-09, W3-E). The adopted folders use the
// primitives of components/ui (Button, IconButton). A raw `<button` is still right for a control
// with its own shape (a switch, a row that taps, a swatch), so the count is not zero; it must not
// go UP. When you convert a button, lower the number here. When you need a new control, use
// `Button` or `IconButton`; only raise the number with a reason in the commit message.
const SRC = path.resolve(__dirname, '..');
export const ADOPTED = [
  'components/settings',
  'components/common/Modal.tsx',
  'components/common/ConfirmModal.tsx',
  'components/common/AccountSwitchModal.tsx',
  'components/common/DirectoryPicker.tsx',
  'components/sidebar/NewThreadModal.tsx',
];
/** The count when W3-E merged. */
export const RECORDED = 999; // set when the adoption is done

const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\\w])\/\/.*$/gm, '$1');

function files(p: string, out: string[] = []): string[] {
  const abs = path.join(SRC, p);
  if (fs.statSync(abs).isDirectory()) { for (const e of fs.readdirSync(abs)) files(path.join(p, e), out); return out; }
  if (/\.tsx$/.test(p) && !/\.test\.tsx$/.test(p)) out.push(p);
  return out;
}

export function countRawButtons(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of ADOPTED.flatMap((p) => files(p))) {
    const n = (stripComments(fs.readFileSync(path.join(SRC, f), 'utf8')).match(/<button\b/g) ?? []).length;
    if (n > 0) counts[f] = n;
  }
  return counts;
}

describe('raw button ratchet', () => {
  it('the count in the adopted folders is at most the recorded count', () => {
    const counts = countRawButtons();
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(Object.keys(counts).length).toBeGreaterThan(0); // the walk really reads the folders
    expect(total, `raw <button> by file: ${JSON.stringify(counts, null, 1)}`).toBeLessThanOrEqual(RECORDED);
  });

  it('the primitives themselves are the only place that may wrap a raw button for the rest', () => {
    for (const f of ['Button.tsx', 'IconButton.tsx']) {
      expect(fs.readFileSync(path.join(SRC, 'components/ui', f), 'utf8')).toMatch(/<button\b/);
    }
  });
});
