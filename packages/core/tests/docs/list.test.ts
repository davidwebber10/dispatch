import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { listDocs, DOCS_ROWS } from '../../src/docs/list.js';
import { makeRepo } from './git-fixture.js';

let r: ReturnType<typeof makeRepo>;
afterEach(() => r?.rm());
const noWriter = () => null;

describe('listDocs', () => {
  it('lists only in-progress docs in the four folders', async () => {
    r = makeRepo();
    r.write('docs/superpowers/specs/on-main.md', 'same');
    r.write('docs/superpowers/specs/edited.md', 'v1');
    r.commit('init');
    const wt = path.join(r.dir, '.worktrees', 'a');
    r.g(r.dir, 'worktree', 'add', '-q', '-b', 'spec/a', wt);
    r.write('docs/superpowers/specs/edited.md', 'v2', wt);         // changed
    r.write('docs/superpowers/plans/new-plan.md', 'p', wt);       // untracked: not on main
    r.write('notes/other.md', 'x', wt);                            // outside the folders
    const { rows, total } = await listDocs({ id: 's1', folder: r.dir }, noWriter);
    expect(rows.map((x) => [x.path, x.vsMain]).sort()).toEqual([['docs/superpowers/plans/new-plan.md', 'not_on_main'], ['docs/superpowers/specs/edited.md', 'changed']]);
    expect(total).toBe(2);
    expect(rows[0]).toMatchObject({ source: 'worktree', worktree: 'a', worktreeRel: '.worktrees/a', branch: 'spec/a' });
  });

  it('a branch with no worktree adds only what it added or changed', async () => {
    r = makeRepo();
    r.write('docs/plans/base.md', 'b'); r.commit('init');
    r.g(r.dir, 'checkout', '-q', '-b', 'spec/c');
    r.write('docs/plans/c.md', 'c'); r.commit('c');
    r.g(r.dir, 'checkout', '-q', 'main');
    const { rows } = await listDocs({ id: 's1', folder: r.dir }, noWriter);
    expect(rows.map((x) => [x.path, x.source, x.branch, x.worktreeRel])).toEqual([['docs/plans/c.md', 'branch', 'spec/c', null]]);
  });

  it('a copy that matches main is not listed', async () => {
    r = makeRepo();
    r.write('docs/specs/x.md', 'same'); r.commit('init');
    r.g(r.dir, 'worktree', 'add', '-q', '-b', 'spec/x', path.join(r.dir, '.worktrees', 'x'));
    expect((await listDocs({ id: 's1', folder: r.dir }, noWriter)).rows).toEqual([]);
  });

  it('one row per path, the newest copy, with the copies count; at most 5 rows and the total', async () => {
    r = makeRepo();
    r.write('README.md', 'x'); r.commit('init');
    const a = path.join(r.dir, '.worktrees', 'a'); const b = path.join(r.dir, '.worktrees', 'b');
    r.g(r.dir, 'worktree', 'add', '-q', '-b', 'spec/a', a);
    r.g(r.dir, 'worktree', 'add', '-q', '-b', 'spec/b', b);
    const old = new Date(2025, 0, 1);
    r.write('docs/specs/same.md', 'old', a);
    fs.utimesSync(path.join(a, 'docs/specs/same.md'), new Date(2026, 0, 1), new Date(2026, 0, 1));
    r.write('docs/specs/same.md', 'new', b); // the newest file of all
    for (let k = 0; k < 6; k++) { r.write(`docs/plans/p${k}.md`, `${k}`, a); fs.utimesSync(path.join(a, `docs/plans/p${k}.md`), old, old); }
    const { rows, total } = await listDocs({ id: 's1', folder: r.dir }, noWriter);
    expect(rows).toHaveLength(DOCS_ROWS);
    expect(total).toBe(7);
    expect(rows[0]).toMatchObject({ path: 'docs/specs/same.md', worktree: 'b', copies: 2 });
  });

  it('the writer comes from the callback, with the worktree folder', async () => {
    r = makeRepo();
    r.write('README.md', 'x'); r.commit('init');
    const a = path.join(r.dir, '.worktrees', 'a');
    r.g(r.dir, 'worktree', 'add', '-q', '-b', 'spec/a', a);
    r.write('docs/specs/w.md', 'w', a);
    const writerOf = vi.fn(() => ({ id: 't1', label: 'Plan: w' }));
    const { rows } = await listDocs({ id: 's1', folder: r.dir }, writerOf);
    expect(rows[0].writer).toEqual({ id: 't1', label: 'Plan: w' });
    expect(writerOf).toHaveBeenCalledWith({ path: 'docs/specs/w.md', worktreeReal: fs.realpathSync(a) });
  });

  it('a folder that is not a git repo lists nothing', async () => {
    r = makeRepo();
    fs.rmSync(path.join(r.dir, '.git'), { recursive: true, force: true });
    r.write('docs/specs/a.md', 'a');
    expect(await listDocs({ id: 's1', folder: r.dir }, noWriter)).toEqual({ rows: [], total: 0 });
  });

  it('a worktree symlink that leads out of the project is not listed', async () => {
    r = makeRepo();
    r.write('README.md', 'x'); r.commit('init');
    const a = path.join(r.dir, '.worktrees', 'a');
    r.g(r.dir, 'worktree', 'add', '-q', '-b', 'spec/a', a);
    fs.writeFileSync(path.join(r.root, 'outside.md'), 'secret');
    fs.mkdirSync(path.join(a, 'docs/specs'), { recursive: true });
    fs.symlinkSync(path.join(r.root, 'outside.md'), path.join(a, 'docs/specs/link.md'));
    r.write('docs/specs/real.md', 'r', a);
    const { rows, total } = await listDocs({ id: 's1', folder: r.dir }, noWriter);
    expect(rows.map((x) => x.path)).toEqual(['docs/specs/real.md']);
    expect(total).toBe(1);
  });

  it('the main checkout adds no rows, even on an unmerged branch', async () => {
    r = makeRepo();
    r.write('README.md', 'x'); r.commit('init');
    r.g(r.dir, 'checkout', '-q', '-b', 'spec/m');
    r.write('docs/specs/m.md', 'm'); r.commit('m');
    expect(await listDocs({ id: 's1', folder: r.dir }, noWriter)).toEqual({ rows: [], total: 0 });
  });

  it('a local branch and its remote-tracking copy count as one copy', async () => {
    r = makeRepo();
    r.write('README.md', 'x'); r.commit('init');
    r.g(r.dir, 'checkout', '-q', '-b', 'fix/x');
    r.write('docs/plans/x.md', 'x'); r.commit('x');
    const sha = r.g(r.dir, 'rev-parse', 'HEAD').trim();
    r.g(r.dir, 'checkout', '-q', 'main');
    r.g(r.dir, 'remote', 'add', 'origin', r.dir);
    r.g(r.dir, 'update-ref', 'refs/remotes/origin/fix/x', sha);
    const { rows, total } = await listDocs({ id: 's1', folder: r.dir }, noWriter);
    expect(rows.map((x) => [x.path, x.branch, x.copies])).toEqual([['docs/plans/x.md', 'fix/x', 1]]);
    expect(total).toBe(1);
  });

  describe('a worktree is compared from its branch point', () => {
    const setup = () => {
      r = makeRepo();
      r.write('docs/specs/a.md', 'v1'); r.commit('init');
      const wt = path.join(r.dir, '.worktrees', 'x');
      r.g(r.dir, 'worktree', 'add', '-q', '-b', 'spec/x', wt);
      r.write('docs/specs/a.md', 'v2'); r.commit('main edits a');
      return wt;
    };
    const list = () => listDocs({ id: 's1', folder: r.dir }, noWriter);

    it('main edited the doc after the branch point: no row', async () => {
      setup();
      expect(await list()).toEqual({ rows: [], total: 0 });
    });

    it('the worktree edits the doc (uncommitted) after main did: listed as changed', async () => {
      const wt = setup();
      r.write('docs/specs/a.md', 'v3', wt);
      const { rows } = await list();
      expect(rows.map((x) => [x.path, x.vsMain])).toEqual([['docs/specs/a.md', 'changed']]);
    });

    it('a new doc committed on the worktree branch is listed as not on main', async () => {
      const wt = setup();
      r.write('docs/plans/n.md', 'n', wt); r.commit('n', wt);
      const { rows } = await list();
      expect(rows.map((x) => [x.path, x.vsMain])).toEqual([['docs/plans/n.md', 'not_on_main']]);
    });

    it('an untracked doc in the worktree is still listed', async () => {
      const wt = setup();
      r.write('docs/plans/u.md', 'u', wt);
      const { rows } = await list();
      expect(rows.map((x) => [x.path, x.vsMain])).toEqual([['docs/plans/u.md', 'not_on_main']]);
    });
  });
});
