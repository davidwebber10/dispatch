import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, type TestRepo } from './repo.fixture.js';
import { threadDiff, type DiffFile } from './diff.js';

let repo: TestRepo;
beforeEach(() => { repo = makeRepo(); });
afterEach(() => repo.cleanup());

const byPath = (files: DiffFile[]) => Object.fromEntries(files.map((f) => [f.path, f]));

describe('threadDiff', () => {
  it('lists a modified, an added and an untracked file', async () => {
    repo.write('a.txt', 'one\nTWO\nthree\nfour\n');
    repo.write('staged-new.txt', 'new\n');
    repo.git('add', 'staged-new.txt');
    repo.write('notes/untracked.txt', 'u1\nu2\n');
    const d = await threadDiff(repo.dir);
    expect(d.truncated).toBe(false);
    expect(d.shared).toBe(false);
    expect(d.repo).toBe(true);
    expect(d.branch).toBe('main');
    expect(d.files.map((f) => f.path).sort()).toEqual(['a.txt', 'notes/untracked.txt', 'staged-new.txt']);
    const f = byPath(d.files);
    expect(f['a.txt']).toMatchObject({ status: 'modified', additions: 2, deletions: 1, staged: false });
    expect(f['a.txt'].patch).toContain('-two');
    expect(f['a.txt'].patch).toContain('+TWO');
    expect(f['staged-new.txt']).toMatchObject({ status: 'added', additions: 1, deletions: 0, staged: true });
    expect(f['notes/untracked.txt']).toMatchObject({ status: 'untracked', additions: 2, deletions: 0, staged: false });
    expect(f['notes/untracked.txt'].patch).toContain('+u1');
  });

  it('lists a deleted, a renamed and a binary file', async () => {
    fs.rmSync(path.join(repo.dir, 'b.txt'));
    repo.git('mv', 'old-name.txt', 'new-name.txt');
    repo.write('logo.bin', Buffer.from([9, 0, 9, 0, 9]));
    repo.write('fresh.bin', Buffer.from([0, 0, 7, 0]));
    const f = byPath((await threadDiff(repo.dir)).files);
    expect(f['b.txt']).toMatchObject({ status: 'deleted', additions: 0, deletions: 1, staged: false });
    expect(f['b.txt'].patch).toContain('-bee');
    expect(f['new-name.txt']).toMatchObject({ status: 'renamed', oldPath: 'old-name.txt', additions: 0, deletions: 0, staged: true });
    expect(f['old-name.txt']).toBeUndefined();
    expect(f['logo.bin']).toMatchObject({ status: 'modified', binary: true });
    expect(f['logo.bin'].patch).toBeUndefined();
    expect(f['fresh.bin']).toMatchObject({ status: 'untracked', binary: true });
    expect(f['fresh.bin'].patch).toBeUndefined();
  });

  it('a path filter returns one file', async () => {
    repo.write('a.txt', 'changed\n');
    repo.write('b.txt', 'changed too\n');
    const d = await threadDiff(repo.dir, { path: 'b.txt' });
    expect(d.files.map((f) => f.path)).toEqual(['b.txt']);
    expect(d.files[0].patch).toContain('+changed too');
    expect((await threadDiff(repo.dir, { path: '../outside.txt' })).files).toEqual([]);
  });

  it('a large diff is cut and flagged', async () => {
    repo.write('a.txt', Array.from({ length: 2000 }, (_, i) => `a much longer line number ${i}`).join('\n') + '\n');
    repo.write('b.txt', 'small change\n');
    const d = await threadDiff(repo.dir, { maxBytes: 2000 });
    expect(d.truncated).toBe(true);
    const f = byPath(d.files);
    // Both files stay in the list, with their counts: the cut is on the patch text only.
    expect(f['a.txt'].additions).toBe(2000);
    expect(Buffer.byteLength(f['a.txt'].patch ?? '')).toBeLessThanOrEqual(2000);
    expect(f['a.txt'].patchCut).toBe(true);
    expect(f['b.txt']).toMatchObject({ status: 'modified', additions: 1 });
    expect(d.files.reduce((n, x) => n + Buffer.byteLength(x.patch ?? ''), 0)).toBeLessThanOrEqual(2000);
  });

  it('shared is true when two live threads use the directory', async () => {
    repo.write('a.txt', 'x\n');
    const other = makeRepo();
    try {
      expect((await threadDiff(repo.dir, { liveDirs: [repo.dir] })).shared).toBe(false);
      expect((await threadDiff(repo.dir, { liveDirs: [repo.dir, other.dir] })).shared).toBe(false);
      // The same directory by another spelling (a trailing slash) is the same directory.
      expect((await threadDiff(repo.dir, { liveDirs: [repo.dir, `${repo.dir}/`] })).shared).toBe(true);
    } finally { other.cleanup(); }
  });

  it('a directory that is not a repository answers repo false and no file', async () => {
    const plain = fs.realpathSync(fs.mkdtempSync(path.join(path.dirname(repo.dir), 'dispatch-w3g-plain-')));
    try {
      fs.writeFileSync(path.join(plain, 'x.txt'), 'x');
      const d = await threadDiff(plain);
      expect(d).toMatchObject({ repo: false, files: [], truncated: false, branch: null });
    } finally { fs.rmSync(plain, { recursive: true, force: true }); }
  });

  it('a working directory below the repository root lists only its own files, with paths from that directory', async () => {
    repo.write('dir/c.txt', 'changed\n');
    repo.write('dir/new.txt', 'n\n');
    repo.write('a.txt', 'outside the directory\n');
    const d = await threadDiff(path.join(repo.dir, 'dir'));
    expect(d.files.map((f) => f.path).sort()).toEqual(['c.txt', 'new.txt']);
  });

  it('never reads through an untracked symbolic link', async () => {
    const outside = path.join(path.dirname(repo.dir), `${path.basename(repo.dir)}.secret`);
    fs.writeFileSync(outside, 'TOP-SECRET\n');
    try {
      fs.symlinkSync(outside, path.join(repo.dir, 'link.txt'));
      const f = byPath((await threadDiff(repo.dir)).files);
      expect(f['link.txt'].status).toBe('untracked');
      expect(JSON.stringify(f['link.txt'])).not.toContain('TOP-SECRET');
    } finally { fs.rmSync(outside, { force: true }); }
  });

  it('a repository with no commit lists every file as new', async () => {
    const empty = fs.realpathSync(fs.mkdtempSync(path.join(path.dirname(repo.dir), 'dispatch-w3g-empty-')));
    try {
      const { gitIn } = await import('./repo.fixture.js');
      gitIn(empty, 'init', '-q', '-b', 'main', '.');
      fs.writeFileSync(path.join(empty, 'x.txt'), 'x\n');
      fs.writeFileSync(path.join(empty, 'y.txt'), 'y\n');
      gitIn(empty, 'add', 'y.txt');
      const f = byPath((await threadDiff(empty)).files);
      expect(f['x.txt'].status).toBe('untracked');
      expect(f['y.txt']).toMatchObject({ status: 'added', staged: true });
    } finally { fs.rmSync(empty, { recursive: true, force: true }); }
  });
});
