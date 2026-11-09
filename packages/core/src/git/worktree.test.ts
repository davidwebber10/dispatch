import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, gitIn, type TestRepo } from './repo.fixture.js';
import { createThreadWorktree, listThreadWorktrees, removeThreadWorktree, WorktreeError } from './worktree.js';

let repo: TestRepo;
beforeEach(() => { repo = makeRepo(); });
afterEach(() => repo.cleanup());

describe('createThreadWorktree', () => {
  it('creates the worktree and the branch', async () => {
    const head = repo.git('rev-parse', 'HEAD').trim();
    const wt = await createThreadWorktree(repo.dir, { name: 'Fix the login page!' });
    expect(wt.branch).toBe('dispatch/fix-the-login-page');
    expect(wt.path).toBe(path.join(repo.dir, '.claude', 'worktrees', 'fix-the-login-page'));
    expect(fs.readFileSync(path.join(wt.path, 'a.txt'), 'utf8')).toBe('one\ntwo\nthree\n');
    expect(gitIn(wt.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('dispatch/fix-the-login-page');
    expect(gitIn(wt.path, 'rev-parse', 'HEAD').trim()).toBe(head);
  });

  it('leaves the project branch, index and uncommitted changes as they were', async () => {
    repo.git('checkout', '-q', '-b', 'feature');
    repo.write('a.txt', 'uncommitted edit\n');
    repo.write('staged.txt', 'staged\n');
    repo.git('add', 'staged.txt');
    repo.write('loose.txt', 'untracked\n');
    const before = { status: repo.status(), head: repo.git('rev-parse', 'HEAD').trim(), branch: repo.git('rev-parse', '--abbrev-ref', 'HEAD').trim(), stash: repo.git('stash', 'list') };
    const wt = await createThreadWorktree(repo.dir);
    expect({ status: repo.status(), head: repo.git('rev-parse', 'HEAD').trim(), branch: repo.git('rev-parse', '--abbrev-ref', 'HEAD').trim(), stash: repo.git('stash', 'list') }).toEqual(before);
    expect(before.branch).toBe('feature');
    expect(repo.read('a.txt')).toBe('uncommitted edit\n');
    expect(repo.read('loose.txt')).toBe('untracked\n');
    // The new worktree starts from the commit, without the uncommitted work of the project.
    expect(fs.readFileSync(path.join(wt.path, 'a.txt'), 'utf8')).toBe('one\ntwo\nthree\n');
    expect(fs.existsSync(path.join(wt.path, 'loose.txt'))).toBe(false);
    expect(gitIn(wt.path, 'rev-parse', 'HEAD').trim()).toBe(before.head);
    // No tracked file of the project changed to hide the folder (.gitignore is not touched).
    expect(repo.exists('.gitignore')).toBe(false);
  });

  it('a second call with the same name gets a new slug', async () => {
    const one = await createThreadWorktree(repo.dir, { name: 'work' });
    const two = await createThreadWorktree(repo.dir, { name: 'work' });
    const three = await createThreadWorktree(repo.dir);
    const four = await createThreadWorktree(repo.dir);
    expect([one.branch, two.branch]).toEqual(['dispatch/work', 'dispatch/work-2']);
    expect(two.path).not.toBe(one.path);
    expect(four.branch).not.toBe(three.branch);
    // A branch name that exists with no folder is not taken again.
    repo.git('branch', 'dispatch/taken');
    expect((await createThreadWorktree(repo.dir, { name: 'taken' })).branch).toBe('dispatch/taken-2');
  });

  it('a hostile name cannot leave the worktrees folder or become an option', async () => {
    for (const name of ['../../escape', '--force', '/abs/path', '..', 'a/../../b', '.git', 'x'.repeat(300)]) {
      const wt = await createThreadWorktree(repo.dir, { name });
      expect(path.dirname(wt.path), name).toBe(path.join(repo.dir, '.claude', 'worktrees'));
      expect(wt.branch, name).toMatch(/^dispatch\/[a-z0-9][a-z0-9-]{0,47}$/);
    }
  });

  it('refuses outside a git repository with a clear error', async () => {
    const plain = fs.realpathSync(fs.mkdtempSync(path.join(path.dirname(repo.dir), 'dispatch-w3g-plain-')));
    try {
      await expect(createThreadWorktree(plain)).rejects.toThrow(/not a git repository/i);
      await expect(createThreadWorktree(plain)).rejects.toBeInstanceOf(WorktreeError);
      expect(fs.readdirSync(plain)).toEqual([]);
    } finally { fs.rmSync(plain, { recursive: true, force: true }); }
  });

  it('refuses a repository with no commit with a clear error', async () => {
    const empty = fs.realpathSync(fs.mkdtempSync(path.join(path.dirname(repo.dir), 'dispatch-w3g-empty-')));
    try {
      gitIn(empty, 'init', '-q', '.');
      await expect(createThreadWorktree(empty)).rejects.toThrow(/no commit/i);
    } finally { fs.rmSync(empty, { recursive: true, force: true }); }
  });
});

describe('removeThreadWorktree', () => {
  it('removes a worktree with no uncommitted work and keeps its branch', async () => {
    const wt = await createThreadWorktree(repo.dir, { name: 'done' });
    fs.writeFileSync(path.join(wt.path, 'a.txt'), 'committed in the worktree\n');
    gitIn(wt.path, 'commit', '-qam', 'work');
    const tip = gitIn(wt.path, 'rev-parse', 'HEAD').trim();
    const res = await removeThreadWorktree(repo.dir, wt.path);
    expect(res).toEqual({ removed: true, path: wt.path, branch: 'dispatch/done' });
    expect(fs.existsSync(wt.path)).toBe(false);
    // The commits stay reachable: the branch is never deleted.
    expect(repo.git('rev-parse', 'dispatch/done').trim()).toBe(tip);
    expect(repo.status()).toBe('');
  });

  it('refuses a worktree with a modified file, and with an untracked file', async () => {
    const wt = await createThreadWorktree(repo.dir, { name: 'busy' });
    fs.writeFileSync(path.join(wt.path, 'a.txt'), 'not committed\n');
    await expect(removeThreadWorktree(repo.dir, wt.path)).rejects.toThrow(/uncommitted/i);
    expect(fs.readFileSync(path.join(wt.path, 'a.txt'), 'utf8')).toBe('not committed\n');
    gitIn(wt.path, 'checkout', '-q', '--', 'a.txt');
    fs.writeFileSync(path.join(wt.path, 'new.txt'), 'untracked work\n');
    await expect(removeThreadWorktree(repo.dir, wt.path)).rejects.toMatchObject({ code: 'dirty' });
    expect(fs.readFileSync(path.join(wt.path, 'new.txt'), 'utf8')).toBe('untracked work\n');
    gitIn(wt.path, 'add', 'new.txt');
    await expect(removeThreadWorktree(repo.dir, wt.path)).rejects.toMatchObject({ code: 'dirty' });
    expect(fs.existsSync(path.join(wt.path, 'new.txt'))).toBe(true);
  });

  it('refuses a worktree that a live thread uses', async () => {
    const wt = await createThreadWorktree(repo.dir, { name: 'live' });
    await expect(removeThreadWorktree(repo.dir, wt.path, { liveDirs: [wt.path] })).rejects.toMatchObject({ code: 'in_use' });
    expect(fs.existsSync(wt.path)).toBe(true);
  });

  it('refuses the project itself, a folder that is not a worktree, and a worktree outside the Dispatch folder', async () => {
    const wt = await createThreadWorktree(repo.dir, { name: 'mine' });
    const elsewhere = `${repo.dir}.elsewhere`;
    repo.git('worktree', 'add', '-q', elsewhere, '-b', 'other');
    try {
      fs.mkdirSync(path.join(repo.dir, '.claude', 'worktrees', 'plain-folder'));
      fs.writeFileSync(path.join(repo.dir, '.claude', 'worktrees', 'plain-folder', 'x.txt'), 'x');
      for (const p of [repo.dir, elsewhere, path.join(repo.dir, '.claude', 'worktrees', 'plain-folder'), path.join(wt.path, '..', '..', '..'), path.join(repo.dir, 'dir'), 'mine']) {
        await expect(removeThreadWorktree(repo.dir, p), p).rejects.toBeInstanceOf(WorktreeError);
      }
      expect(fs.existsSync(elsewhere)).toBe(true);
      expect(repo.read('a.txt')).toBe('one\ntwo\nthree\n');
      expect(repo.exists('.claude/worktrees/plain-folder/x.txt')).toBe(true);
    } finally { fs.rmSync(elsewhere, { recursive: true, force: true }); }
  });
});

describe('listThreadWorktrees', () => {
  it('lists the Dispatch worktrees with their branch and whether they hold uncommitted work', async () => {
    const clean = await createThreadWorktree(repo.dir, { name: 'clean' });
    const dirty = await createThreadWorktree(repo.dir, { name: 'dirty' });
    fs.writeFileSync(path.join(dirty.path, 'new.txt'), 'x\n');
    const list = await listThreadWorktrees(repo.dir, { liveDirs: [dirty.path] });
    expect(list).toEqual([
      { path: clean.path, branch: 'dispatch/clean', dirty: false, inUse: false },
      { path: dirty.path, branch: 'dispatch/dirty', dirty: true, inUse: true },
    ]);
    expect(await listThreadWorktrees(path.dirname(repo.dir))).toEqual([]);
  });
});
