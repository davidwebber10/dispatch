import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { listDocs, DOCS_ROWS } from '../../src/docs/list.js';
import { makeRepo } from './git-fixture.js';

let r: ReturnType<typeof makeRepo>;
afterEach(() => r?.rm());
const noWriter = () => null;

describe('listDocs', () => {
  it('lists only in-progress docs in the four folders', () => {
    r = makeRepo();
    r.write('docs/superpowers/specs/on-main.md', 'same');
    r.write('docs/superpowers/specs/edited.md', 'v1');
    r.commit('init');
    const wt = path.join(r.dir, '.worktrees', 'a');
    r.g(r.dir, 'worktree', 'add', '-q', '-b', 'spec/a', wt);
    r.write('docs/superpowers/specs/edited.md', 'v2', wt);         // changed
    r.write('docs/superpowers/plans/new-plan.md', 'p', wt);       // untracked: not on main
    r.write('notes/other.md', 'x', wt);                            // outside the folders
    const { rows, total } = listDocs({ id: 's1', folder: r.dir }, noWriter);
    expect(rows.map((x) => [x.path, x.vsMain]).sort()).toEqual([['docs/superpowers/plans/new-plan.md', 'not_on_main'], ['docs/superpowers/specs/edited.md', 'changed']]);
    expect(total).toBe(2);
    expect(rows[0]).toMatchObject({ source: 'worktree', worktree: 'a', branch: 'spec/a' });
  });

  it('a branch with no worktree adds only what it added or changed', () => {
    r = makeRepo();
    r.write('docs/plans/base.md', 'b'); r.commit('init');
    r.g(r.dir, 'checkout', '-q', '-b', 'spec/c');
    r.write('docs/plans/c.md', 'c'); r.commit('c');
    r.g(r.dir, 'checkout', '-q', 'main');
    const { rows } = listDocs({ id: 's1', folder: r.dir }, noWriter);
    expect(rows.map((x) => [x.path, x.source, x.branch])).toEqual([['docs/plans/c.md', 'branch', 'spec/c']]);
  });

  it('a copy that matches main is not listed', () => {
    r = makeRepo();
    r.write('docs/specs/x.md', 'same'); r.commit('init');
    r.g(r.dir, 'worktree', 'add', '-q', '-b', 'spec/x', path.join(r.dir, '.worktrees', 'x'));
    expect(listDocs({ id: 's1', folder: r.dir }, noWriter).rows).toEqual([]);
  });

  it('one row per path, the newest copy, with the copies count; at most 5 rows and the total', () => {
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
    const { rows, total } = listDocs({ id: 's1', folder: r.dir }, noWriter);
    expect(rows).toHaveLength(DOCS_ROWS);
    expect(total).toBe(7);
    expect(rows[0]).toMatchObject({ path: 'docs/specs/same.md', worktree: 'b', copies: 2 });
  });

  it('the writer comes from the callback, with the worktree folder', () => {
    r = makeRepo();
    r.write('README.md', 'x'); r.commit('init');
    const a = path.join(r.dir, '.worktrees', 'a');
    r.g(r.dir, 'worktree', 'add', '-q', '-b', 'spec/a', a);
    r.write('docs/specs/w.md', 'w', a);
    const writerOf = vi.fn(() => ({ id: 't1', label: 'Plan: w' }));
    const { rows } = listDocs({ id: 's1', folder: r.dir }, writerOf);
    expect(rows[0].writer).toEqual({ id: 't1', label: 'Plan: w' });
    expect(writerOf).toHaveBeenCalledWith({ path: 'docs/specs/w.md', worktreeReal: fs.realpathSync(a) });
  });

  it('a folder that is not a git repo lists nothing', () => {
    r = makeRepo();
    fs.rmSync(path.join(r.dir, '.git'), { recursive: true, force: true });
    r.write('docs/specs/a.md', 'a');
    expect(listDocs({ id: 's1', folder: r.dir }, noWriter)).toEqual({ rows: [], total: 0 });
  });
});
