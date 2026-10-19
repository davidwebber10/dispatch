import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readConfined } from '../../src/docs/confined.js';
import { locate } from '../../src/overseer/source-file.js';

const MAX = 64;
let root: string;
let project: string;
let outside: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ctv-')));
  project = path.join(root, 'project');
  outside = path.join(root, 'outside');
  fs.mkdirSync(path.join(project, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(outside, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(project, 'docs', 'a.md'), 'inside');
  fs.writeFileSync(path.join(outside, 'docs', 'a.md'), 'outside secret');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

/** The real path `locate` gives for docs/a.md: the check step. */
const checked = () => {
  const real = locate(project, 'docs/a.md');
  if (real === 'missing' || real === 'outside') throw new Error(`not located: ${real}`);
  return real;
};
const text = (r: Awaited<ReturnType<typeof readConfined>>) => (r.kind === 'file' ? r.bytes.toString('utf8') : null);

describe('readConfined', () => {
  it('reads a regular file inside the project, with its mtime', async () => {
    const r = await readConfined(project, checked(), MAX);
    expect(r.kind).toBe('file');
    expect(text(r)).toBe('inside');
    if (r.kind === 'file') expect(r.mtime).toBeInstanceOf(Date);
  });

  it('a file over the cap is too large; a folder, a missing path and a non-regular file are not read', async () => {
    fs.writeFileSync(path.join(project, 'docs', 'big.md'), 'x'.repeat(MAX + 1));
    expect(await readConfined(project, path.join(project, 'docs', 'big.md'), MAX)).toEqual({ kind: 'too_large', size: MAX + 1 });
    expect((await readConfined(project, path.join(project, 'docs'), MAX)).kind).toBe('folder');
    expect((await readConfined(project, path.join(project, 'docs', 'none.md'), MAX)).kind).toBe('missing');
    fs.symlinkSync(path.join(project, 'docs', 'a.md'), path.join(project, 'docs', 'link.md'));
    // A real path is never a symlink: one there means the path changed after the check.
    expect((await readConfined(project, path.join(project, 'docs', 'link.md'), MAX)).kind).toBe('changed');
  });

  it('a file swapped for a symlink to an outside file after the check is refused, never the outside content', async () => {
    const real = checked();
    const r = await readConfined(project, real, MAX, {
      beforeOpen: () => {
        fs.rmSync(real);
        fs.symlinkSync(path.join(outside, 'docs', 'a.md'), real);
      },
    });
    expect(text(r)).not.toBe('outside secret');
    expect(r.kind).toBe('changed');
  });

  it('a parent folder swapped for a symlink to an outside folder after the check is refused', async () => {
    const real = checked();
    const r = await readConfined(project, real, MAX, {
      beforeOpen: () => {
        fs.renameSync(path.join(project, 'docs'), path.join(project, 'docs-old'));
        fs.symlinkSync(path.join(outside, 'docs'), path.join(project, 'docs'));
      },
    });
    expect(text(r)).not.toBe('outside secret');
    expect(['changed', 'outside']).toContain(r.kind);
  });

  it('a file replaced by another file inside the project after the check is refused (a different file)', async () => {
    const real = checked();
    const r = await readConfined(project, real, MAX, {
      beforeOpen: () => {
        // Made while the old file still exists, so it is a different inode; then renamed over it.
        fs.writeFileSync(`${real}.new`, 'other');
        fs.renameSync(`${real}.new`, real);
      },
    });
    expect(r.kind).toBe('changed');
  });

  it('a file that grew past the cap after the check is too large, read from the open file only', async () => {
    const real = checked();
    const r = await readConfined(project, real, MAX, { beforeOpen: () => fs.appendFileSync(real, 'x'.repeat(MAX)) });
    expect(r.kind).toBe('too_large');
  });

  it('a parent folder swapped for an outside symlink after locate, before the read, is outside (the realpath re-check)', async () => {
    const real = checked();
    fs.renameSync(path.join(project, 'docs'), path.join(project, 'docs-old'));
    fs.symlinkSync(path.join(outside, 'docs'), path.join(project, 'docs'));
    const r = await readConfined(project, real, MAX);
    expect(text(r)).not.toBe('outside secret');
    expect(r.kind).toBe('outside');
  });

  it.skipIf(process.getuid?.() === 0)('a file that cannot be opened (mode 000) reads as missing, not changed', async () => {
    const real = checked();
    fs.chmodSync(real, 0o000); // root skips this test: root opens any file
    try {
      expect((await readConfined(project, real, MAX)).kind).toBe('missing');
    } finally {
      fs.chmodSync(real, 0o644);
    }
  });

  it('a file that grew after the open, still under the cap, is changed, not a cut copy', async () => {
    const real = checked();
    const r = await readConfined(project, real, MAX, { afterOpen: () => fs.appendFileSync(real, 'x'.repeat(10)) });
    expect(r.kind).toBe('changed');
  });
});
