import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeRepo, type TestRepo } from './repo.fixture.js';
import { approvePaths, discardPaths } from './apply.js';
import { PathRefused } from './paths.js';

let repo: TestRepo;
let outside: string;
beforeEach(() => {
  repo = makeRepo();
  outside = path.join(path.dirname(repo.dir), `${path.basename(repo.dir)}.outside`);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'outside the project\n');
});
afterEach(() => { repo.cleanup(); fs.rmSync(outside, { recursive: true, force: true }); });

const roots = () => ({ home: path.join(repo.dir, 'no-home'), dataDir: path.join(repo.dir, 'no-data') });
const staged = () => repo.git('diff', '--cached', '--no-renames', '--name-only').trim().split('\n').filter(Boolean).sort();

/** Every kind of change at once. `b.txt` and `also-untracked.txt` are the unrelated work that must survive. */
function dirty() {
  repo.write('a.txt', 'one\nTWO\nthree\n');           // modified
  repo.write('b.txt', 'unrelated edit\n');            // modified, unrelated
  fs.rmSync(path.join(repo.dir, 'dir/c.txt'));        // deleted
  repo.git('mv', 'old-name.txt', 'new-name.txt');     // renamed (staged)
  repo.write('staged-new.txt', 'new\n');              // added (staged)
  repo.git('add', 'staged-new.txt');
  repo.write('untracked.txt', 'u\n');                 // untracked
  repo.write('also-untracked.txt', 'keep me\n');      // untracked, unrelated
  repo.write('logo.bin', Buffer.from([7, 0, 7]));     // binary, modified
}

describe('approvePaths', () => {
  it('stages exactly the listed paths and makes no commit', async () => {
    dirty();
    const head = repo.git('rev-parse', 'HEAD').trim();
    const res = await approvePaths(repo.dir, ['a.txt', 'untracked.txt', 'dir/c.txt'], roots());
    expect(res.staged.sort()).toEqual(['a.txt', 'dir/c.txt', 'untracked.txt']);
    // new-name / old-name / staged-new were in the index before the call.
    expect(staged()).toEqual(['a.txt', 'dir/c.txt', 'new-name.txt', 'old-name.txt', 'staged-new.txt', 'untracked.txt']);
    expect(repo.git('rev-parse', 'HEAD').trim()).toBe(head);
    expect(repo.git('rev-list', '--count', 'HEAD').trim()).toBe('1');
    // The work itself is as it was.
    expect(repo.read('a.txt')).toBe('one\nTWO\nthree\n');
    expect(repo.read('b.txt')).toBe('unrelated edit\n');
    expect(repo.status()).toContain(' M b.txt');
    expect(repo.status()).toContain('?? also-untracked.txt');
  });

  it('refuses a path that is not a changed file, and stages nothing', async () => {
    dirty();
    const before = repo.status();
    await expect(approvePaths(repo.dir, ['a.txt', 'dir'], roots())).rejects.toBeInstanceOf(PathRefused);
    await expect(approvePaths(repo.dir, ['.'], roots())).rejects.toBeInstanceOf(PathRefused);
    await expect(approvePaths(repo.dir, ['*'], roots())).rejects.toBeInstanceOf(PathRefused);
    await expect(approvePaths(repo.dir, [], roots())).rejects.toBeInstanceOf(PathRefused);
    expect(repo.status()).toBe(before);
  });
});

describe('discardPaths', () => {
  it('one modified file: restores it and nothing else', async () => {
    dirty();
    const before = repo.status();
    const res = await discardPaths(repo.dir, ['a.txt'], roots());
    expect(res.discarded.map((d) => d.path)).toEqual(['a.txt']);
    expect(res.errors).toEqual([]);
    expect(repo.read('a.txt')).toBe('one\ntwo\nthree\n');
    // The status is the one from before, less the a.txt line.
    expect(repo.status()).toBe(before.split('\n').filter((l) => !l.endsWith(' a.txt')).join('\n'));
    expect(repo.read('b.txt')).toBe('unrelated edit\n');
    expect(repo.read('also-untracked.txt')).toBe('keep me\n');
    expect(repo.read('untracked.txt')).toBe('u\n');
  });

  it('every shown file but the unrelated ones: restores exactly those', async () => {
    dirty();
    const shown = ['a.txt', 'dir/c.txt', 'new-name.txt', 'staged-new.txt', 'untracked.txt', 'logo.bin'];
    const res = await discardPaths(repo.dir, shown, roots());
    expect(res.errors).toEqual([]);
    expect(res.discarded.map((d) => d.path).sort()).toEqual([...shown].sort());
    expect(repo.read('a.txt')).toBe('one\ntwo\nthree\n');
    expect(repo.read('dir/c.txt')).toBe('sea\n');
    expect(repo.exists('new-name.txt')).toBe(false);
    expect(repo.read('old-name.txt')).toContain('line 12');
    expect(repo.exists('staged-new.txt')).toBe(false);
    expect(repo.exists('untracked.txt')).toBe(false);
    expect([...fs.readFileSync(path.join(repo.dir, 'logo.bin'))]).toEqual([0, 1, 2, 3, 0, 255, 254, 0]);
    // The unrelated uncommitted work is all that is left.
    expect(repo.status()).toBe(' M b.txt\n?? also-untracked.txt\n');
    expect(repo.read('b.txt')).toBe('unrelated edit\n');
    expect(repo.read('also-untracked.txt')).toBe('keep me\n');
  });

  it('keeps a copy of the discarded content in the git object store', async () => {
    dirty();
    const res = await discardPaths(repo.dir, ['a.txt', 'untracked.txt'], roots());
    const copy = Object.fromEntries(res.discarded.map((d) => [d.path, d.backup]));
    expect(repo.git('cat-file', '-p', copy['a.txt']!)).toBe('one\nTWO\nthree\n');
    expect(repo.git('cat-file', '-p', copy['untracked.txt']!)).toBe('u\n');
  });

  it('a staged and then edited file goes back to HEAD', async () => {
    repo.write('a.txt', 'staged\n');
    repo.git('add', 'a.txt');
    repo.write('a.txt', 'staged and edited\n');
    await discardPaths(repo.dir, ['a.txt'], roots());
    expect(repo.read('a.txt')).toBe('one\ntwo\nthree\n');
    expect(repo.status()).toBe('');
  });

  it('refuses path traversal, absolute paths and git metadata, and changes nothing', async () => {
    dirty();
    const before = repo.status();
    for (const bad of ['../' + path.basename(outside) + '/keep.txt', path.join(outside, 'keep.txt'), 'dir/../../x', '.git/config', 'dir/../a.txt', './a.txt', 'a.txt\0b', '']) {
      await expect(discardPaths(repo.dir, [bad], roots()), JSON.stringify(bad)).rejects.toBeInstanceOf(PathRefused);
    }
    // One bad path refuses the whole call: the good path beside it is not touched.
    await expect(discardPaths(repo.dir, ['a.txt', '../x'], roots())).rejects.toBeInstanceOf(PathRefused);
    await expect(discardPaths(repo.dir, 'a.txt' as unknown as string[], roots())).rejects.toBeInstanceOf(PathRefused);
    expect(repo.status()).toBe(before);
    expect(repo.read('a.txt')).toBe('one\nTWO\nthree\n');
    expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('outside the project\n');
  });

  it('refuses a directory, a pathspec and an unchanged file: never a broad restore', async () => {
    dirty();
    repo.write('dir/extra.txt', 'x\n');
    const before = repo.status();
    for (const bad of ['dir', 'dir/', '.', '*', ':/', ':(glob)**', '*.txt', 'no-such-file.txt']) {
      await expect(discardPaths(repo.dir, [bad], roots()), bad).rejects.toBeInstanceOf(PathRefused);
    }
    expect(repo.status()).toBe(before);
  });

  it('refuses a path through a symbolic link to a place outside the project', async () => {
    fs.symlinkSync(outside, path.join(repo.dir, 'link'));
    const before = repo.status();
    await expect(discardPaths(repo.dir, ['link/keep.txt'], roots())).rejects.toBeInstanceOf(PathRefused);
    expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('outside the project\n');
    expect(repo.status()).toBe(before);
  });

  it('an untracked symbolic link: removes the link, never its target', async () => {
    fs.symlinkSync(path.join(outside, 'keep.txt'), path.join(repo.dir, 'link.txt'));
    fs.symlinkSync(outside, path.join(repo.dir, 'linkdir'));
    await discardPaths(repo.dir, ['link.txt', 'linkdir'], roots());
    expect(fs.existsSync(path.join(repo.dir, 'link.txt'))).toBe(false);
    expect(fs.existsSync(path.join(repo.dir, 'linkdir'))).toBe(false);
    expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('outside the project\n');
  });

  it('a working directory that is a link to the repository: the real paths are compared, so a normal file works', async () => {
    // The thread's directory is a link to the repository: the real paths are compared, so a normal file works.
    const alias = `${repo.dir}.alias`;
    fs.symlinkSync(repo.dir, alias);
    try {
      repo.write('a.txt', 'edited\n');
      await discardPaths(alias, ['a.txt'], roots());
      expect(repo.read('a.txt')).toBe('one\ntwo\nthree\n');
    } finally { fs.unlinkSync(alias); }
  });

  it('refuses a credentials path', async () => {
    repo.write('.ssh/id_test', 'KEY\n');
    await expect(discardPaths(repo.dir, ['.ssh/id_test'], { home: repo.dir, dataDir: path.join(repo.dir, 'no-data') })).rejects.toBeInstanceOf(PathRefused);
    expect(repo.read('.ssh/id_test')).toBe('KEY\n');
  });

  it('refuses an untracked directory that is its own repository', async () => {
    fs.mkdirSync(path.join(repo.dir, 'nested'));
    execFileSync('git', ['-C', path.join(repo.dir, 'nested'), 'init', '-q', '.']);
    fs.writeFileSync(path.join(repo.dir, 'nested', 'work.txt'), 'work\n');
    execFileSync('git', ['-C', path.join(repo.dir, 'nested'), '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A']);
    execFileSync('git', ['-C', path.join(repo.dir, 'nested'), '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'n']);
    await expect(discardPaths(repo.dir, ['nested/'], roots())).rejects.toBeInstanceOf(PathRefused);
    await expect(discardPaths(repo.dir, ['nested'], roots())).rejects.toBeInstanceOf(PathRefused);
    expect(repo.read('nested/work.txt')).toBe('work\n');
  });

  it('in a working directory below the repository root, a file outside that directory is refused', async () => {
    repo.write('a.txt', 'edited\n');
    repo.write('dir/c.txt', 'edited\n');
    const sub = path.join(repo.dir, 'dir');
    await expect(discardPaths(sub, ['../a.txt'], roots())).rejects.toBeInstanceOf(PathRefused);
    await expect(discardPaths(sub, ['a.txt'], roots())).rejects.toBeInstanceOf(PathRefused);
    await discardPaths(sub, ['c.txt'], roots());
    expect(repo.read('dir/c.txt')).toBe('sea\n');
    expect(repo.read('a.txt')).toBe('edited\n');
  });
});

// v4.5.0 review, I5: `git restore` and `git add` act on whatever stands at the path. A folder that took the place of a
// tracked file, or a file that took the place of a folder on the way, made them touch files the page did not name.
describe('a path whose place on the disk is no longer a file', () => {
  /** The tracked file `b.txt` is deleted and a folder `b.txt/` stands there, with an ignored file and a new file. */
  function folderAtFilePath() {
    repo.write('.gitignore', 'b.txt/.env\n');
    repo.git('add', '.gitignore');
    repo.git('commit', '-qm', 'ignore');
    fs.rmSync(path.join(repo.dir, 'b.txt'));
    repo.write('b.txt/.env', 'SECRET=1\n');     // ignored: git status does not list it
    repo.write('b.txt/notes.txt', 'my notes\n'); // untracked: listed as its own row
  }

  it('discard refuses a deleted file whose path is a folder now, and the folder stays as it is', async () => {
    folderAtFilePath();
    const before = repo.status();
    expect(before).toContain(' D b.txt');
    await expect(discardPaths(repo.dir, ['b.txt'], roots())).rejects.toThrow(/is a folder now/);
    await expect(discardPaths(repo.dir, ['b.txt'], roots())).rejects.toBeInstanceOf(PathRefused);
    expect(repo.read('b.txt/.env')).toBe('SECRET=1\n');
    expect(repo.read('b.txt/notes.txt')).toBe('my notes\n');
    expect(repo.status()).toBe(before);
    // One bad path refuses the whole call: the other file is not touched.
    repo.write('a.txt', 'edited\n');
    await expect(discardPaths(repo.dir, ['a.txt', 'b.txt'], roots())).rejects.toThrow(/is a folder now/);
    expect(repo.read('a.txt')).toBe('edited\n');
    // The file inside the folder is a row of its own, and its discard removes that one file only.
    const res = await discardPaths(repo.dir, ['b.txt/notes.txt'], roots());
    expect(res.errors).toEqual([]);
    expect(repo.exists('b.txt/notes.txt')).toBe(false);
    expect(repo.read('b.txt/.env')).toBe('SECRET=1\n');
  });

  it('approve refuses it too: `git add` on the folder would stage files the page did not name', async () => {
    folderAtFilePath();
    await expect(approvePaths(repo.dir, ['b.txt'], roots())).rejects.toThrow(/is a folder now/);
    expect(staged()).toEqual([]);
    expect(repo.read('b.txt/.env')).toBe('SECRET=1\n');
  });

  it('discard refuses a file below a folder that is a file now, and that file stays', async () => {
    fs.rmSync(path.join(repo.dir, 'dir'), { recursive: true });
    repo.write('dir', 'a file where the folder was\n');
    const before = repo.status();
    expect(before).toContain(' D dir/c.txt');
    await expect(discardPaths(repo.dir, ['dir/c.txt'], roots())).rejects.toThrow(/is not a folder/);
    await expect(approvePaths(repo.dir, ['dir/c.txt'], roots())).rejects.toThrow(/is not a folder/);
    expect(repo.read('dir')).toBe('a file where the folder was\n');
    expect(repo.status()).toBe(before);
    expect(staged()).toEqual([]);
  });

  it('a rename whose old path is a folder now is refused: the restore of the old file would remove the folder', async () => {
    repo.git('mv', 'old-name.txt', 'new-name.txt');
    repo.write('old-name.txt/keep.txt', 'keep\n');
    repo.git('update-index', '--refresh');
    await expect(discardPaths(repo.dir, ['new-name.txt'], roots())).rejects.toThrow(/is a folder now/);
    expect(repo.read('old-name.txt/keep.txt')).toBe('keep\n');
    expect(repo.exists('new-name.txt')).toBe(true);
  });

  it('a deleted file in a deleted folder is still restored: nothing stands in the way', async () => {
    fs.rmSync(path.join(repo.dir, 'dir'), { recursive: true });
    const res = await discardPaths(repo.dir, ['dir/c.txt'], roots());
    expect(res.errors).toEqual([]);
    expect(repo.read('dir/c.txt')).toBe('sea\n');
  });
});

describe('a repository cannot make the review run a command', () => {
  it('diff, approve and discard do not run core.fsmonitor', async () => {
    const { threadDiff } = await import('./diff.js');
    const marker = `${repo.dir}.marker`;
    const hook = `${repo.dir}.hook.sh`;
    fs.writeFileSync(hook, `#!/bin/sh\necho ran >> "${marker}"\nexit 1\n`, { mode: 0o755 });
    try {
      repo.git('config', 'core.fsmonitor', hook);
      repo.write('a.txt', 'edited\n');
      repo.write('b.txt', 'edited\n');
      fs.rmSync(marker, { force: true });
      expect((await threadDiff(repo.dir)).files.map((f) => f.path)).toEqual(['a.txt', 'b.txt']);
      await approvePaths(repo.dir, ['a.txt'], roots());
      await discardPaths(repo.dir, ['b.txt'], roots());
      expect(repo.read('b.txt')).toBe('bee\n');
      expect(fs.existsSync(marker)).toBe(false);
    } finally { fs.rmSync(marker, { force: true }); fs.rmSync(hook, { force: true }); }
  });

  // v4.5.0 review (minor): `git diff` cleans a changed file with the filter that the attributes name, and the
  // command of that filter comes from the config of the repository.
  it('the diff does not run a filter command that the config of the repository defines', async () => {
    const { threadDiff, listChanges } = await import('./diff.js');
    const marker = `${repo.dir}.marker`;
    const hook = `${repo.dir}.filter.sh`;
    fs.writeFileSync(hook, `#!/bin/sh\necho ran >> "${marker}"\ncat\n`, { mode: 0o755 });
    try {
      repo.write('.gitattributes', '*.txt filter=evil\n');
      repo.git('config', 'filter.evil.clean', hook);
      repo.git('config', 'filter.evil.process', hook);
      repo.git('config', 'filter.evil.required', 'true');
      repo.write('a.txt', 'edited\n');
      fs.rmSync(marker, { force: true });
      const d = await threadDiff(repo.dir);
      expect(d.files.map((f) => f.path)).toEqual(['.gitattributes', 'a.txt']);
      expect(d.files[1]).toMatchObject({ status: 'modified', additions: 1, deletions: 3 });
      expect(d.files[1].patch).toContain('+edited');
      expect((await listChanges(repo.dir)).map((c) => c.path)).toEqual(['.gitattributes', 'a.txt']);
      expect(fs.existsSync(marker)).toBe(false);
    } finally { fs.rmSync(marker, { force: true }); fs.rmSync(hook, { force: true }); }
  });

  it('only the filters of the repository config are turned off, and the commands of git-lfs stay', async () => {
    const { repoFiltersOff } = await import('./exec.js');
    expect(await repoFiltersOff(repo.dir)).toEqual([]); // the usual repository: nothing to turn off
    repo.git('config', 'filter.lfs.clean', 'git-lfs clean -- %f');
    repo.git('config', 'filter.lfs.smudge', 'git-lfs smudge -- %f');
    repo.git('config', 'filter.lfs.process', 'git-lfs filter-process');
    repo.git('config', 'filter.lfs.required', 'true');
    expect(await repoFiltersOff(repo.dir)).toEqual([]); // what `git lfs install --local` writes: the user's own tool
    repo.git('config', 'filter.odd=name with.dots.smudge', 'sh -c "id"');
    expect(await repoFiltersOff(repo.dir)).toEqual([
      ['filter.odd=name with.dots.clean', ''], ['filter.odd=name with.dots.smudge', ''], ['filter.odd=name with.dots.process', ''], ['filter.odd=name with.dots.required', 'false'],
    ]);
    // A changed git-lfs entry is a command of the repository like any other.
    repo.git('config', 'filter.lfs.clean', 'git-lfs clean -- %f; id');
    expect((await repoFiltersOff(repo.dir)).map(([k]) => k)).toContain('filter.lfs.clean');
  });
});
