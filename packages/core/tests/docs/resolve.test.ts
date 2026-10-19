import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveDoc, statusLine, DOC_MAX_BYTES } from '../../src/docs/resolve.js';
import { refs, gitArgs } from '../../src/docs/git.js';
import { makeRepo } from './git-fixture.js';

const SPEC = 'docs/superpowers/specs/a-design.md';
let r: ReturnType<typeof makeRepo>;
afterEach(() => r?.rm());
const project = () => ({ id: 's1', folder: r.dir });
const doc = (res: ReturnType<typeof resolveDoc>) => { if (res.kind !== 'doc') throw new Error(`not a doc: ${JSON.stringify(res)}`); return res.doc; };

describe('resolveDoc', () => {
  it('the main checkout copy, same as main, with its status line', () => {
    r = makeRepo();
    r.write(SPEC, '# A\n\nStatus: draft, awaiting owner review\n');
    r.commit('a');
    const d = doc(resolveDoc(project(), SPEC));
    expect(d).toMatchObject({ source: 'main', path: SPEC, vsMain: 'same', status: 'draft, awaiting owner review', worktree: null });
    expect(d.absPath).toBe(path.join(r.dir, SPEC));
  });

  it('a .worktrees copy that main lacks: not_on_main, with the worktree and branch', () => {
    r = makeRepo();
    r.write('README.md', 'x'); r.commit('init');
    r.g(r.dir, 'worktree', 'add', '-q', '-b', 'spec/a', path.join(r.dir, '.worktrees', 'a'));
    r.write(SPEC, '# A\n', path.join(r.dir, '.worktrees', 'a'));
    const d = doc(resolveDoc(project(), SPEC));
    expect(d).toMatchObject({ source: 'worktree', worktree: 'a', branch: 'spec/a', vsMain: 'not_on_main' });
  });

  it('a .claude/worktrees copy that changed: changed', () => {
    r = makeRepo();
    r.write(SPEC, 'v1'); r.commit('init');
    r.g(r.dir, 'worktree', 'add', '-q', '-b', 'spec/b', path.join(r.dir, '.claude', 'worktrees', 'b'));
    const wt = path.join(r.dir, '.claude', 'worktrees', 'b');
    fs.writeFileSync(path.join(wt, SPEC), 'v2');
    const d = doc(resolveDoc(project(), `.claude/worktrees/b/${SPEC}`));
    expect(d).toMatchObject({ source: 'worktree', worktree: 'b', vsMain: 'changed', markdown: 'v2' });
  });

  it('an absolute path inside a worktree', () => {
    r = makeRepo();
    r.write('README.md', 'x'); r.commit('init');
    const wt = path.join(r.dir, '.worktrees', 'a');
    r.g(r.dir, 'worktree', 'add', '-q', '-b', 'spec/a', wt);
    r.write(SPEC, 'w', wt);
    expect(doc(resolveDoc(project(), path.join(wt, SPEC)))).toMatchObject({ source: 'worktree', worktree: 'a' });
  });

  it('a removed worktree path reads the named branch', () => {
    r = makeRepo();
    r.write('README.md', 'x'); r.commit('init');
    const wt = path.join(r.dir, '.worktrees', 'gone');
    r.g(r.dir, 'worktree', 'add', '-q', '-b', 'spec/gone', wt);
    r.write(SPEC, 'from branch', wt); r.commit('doc', wt);
    r.g(r.dir, 'worktree', 'remove', '--force', wt);
    const d = doc(resolveDoc(project(), `.worktrees/gone/${SPEC}`, { branch: 'spec/gone' }));
    expect(d).toMatchObject({ source: 'branch', branch: 'spec/gone', absPath: null, markdown: 'from branch', vsMain: 'not_on_main' });
  });

  it('a removed worktree path with no branch named uses the branch that ends in its name', () => {
    r = makeRepo();
    r.write('README.md', 'x'); r.commit('init');
    const wt = path.join(r.dir, '.worktrees', 'gone');
    r.g(r.dir, 'worktree', 'add', '-q', '-b', 'spec/gone', wt);
    r.write(SPEC, 'b', wt); r.commit('doc', wt);
    r.g(r.dir, 'worktree', 'remove', '--force', wt);
    expect(doc(resolveDoc(project(), `.worktrees/gone/${SPEC}`))).toMatchObject({ source: 'branch', branch: 'spec/gone' });
  });

  it('an unmerged branch with no worktree', () => {
    r = makeRepo();
    r.write('README.md', 'x'); r.commit('init');
    r.g(r.dir, 'checkout', '-q', '-b', 'spec/c');
    r.write(SPEC, 'c'); r.commit('c');
    r.g(r.dir, 'checkout', '-q', 'main');
    expect(doc(resolveDoc(project(), SPEC))).toMatchObject({ source: 'branch', branch: 'spec/c', vsMain: 'not_on_main', markdown: 'c' });
  });

  it('not found lists where it looked', () => {
    r = makeRepo();
    r.write('README.md', 'x'); r.commit('init');
    const res = resolveDoc(project(), 'docs/plans/none.md');
    expect(res.kind).toBe('not_found');
    if (res.kind === 'not_found') {
      expect(Array.isArray(res.looked)).toBe(true);
      expect(res.looked.length).toBeGreaterThan(0);
      expect(res.looked).toContain('docs/plans/none.md');
    }
  });

  it('a removed worktree path also searches unmerged branches whose name differs', () => {
    r = makeRepo();
    r.write('README.md', 'x'); r.commit('init');
    const wt = path.join(r.dir, '.worktrees', 'wt-x');
    r.g(r.dir, 'worktree', 'add', '-q', '-b', 'feat/other-name', wt);
    r.write(SPEC, 'other', wt); r.commit('doc', wt);
    r.g(r.dir, 'worktree', 'remove', '--force', wt);
    expect(doc(resolveDoc(project(), `.worktrees/wt-x/${SPEC}`))).toMatchObject({ source: 'branch', branch: 'feat/other-name', markdown: 'other' });
  });

  it('the note says "is gone" only when the worktree folder is gone', () => {
    r = makeRepo();
    r.write('README.md', 'x'); r.commit('init');
    const wt = path.join(r.dir, '.worktrees', 'wt-e');
    r.g(r.dir, 'worktree', 'add', '-q', '-b', 'spec/e', wt);
    r.g(r.dir, 'branch', 'spec/f');
    r.g(r.dir, 'checkout', '-q', 'spec/f');
    r.write(SPEC, 'f'); r.commit('f');
    r.g(r.dir, 'checkout', '-q', 'main');
    const kept = doc(resolveDoc(project(), `.worktrees/wt-e/${SPEC}`, { branch: 'spec/f' }));
    expect(kept.note).toBe('The worktree "wt-e" does not have this file; read from the branch.');
    r.g(r.dir, 'worktree', 'remove', '--force', wt);
    const gone = doc(resolveDoc(project(), `.worktrees/wt-e/${SPEC}`, { branch: 'spec/f' }));
    expect(gone.note).toBe('The worktree "wt-e" is gone; read from the branch.');
  });

  it('a removed or file-less worktree path falls back to the main checkout copy, with the matching note', () => {
    r = makeRepo();
    r.write(SPEC, 'main copy'); r.commit('init');
    const wt = path.join(r.dir, '.worktrees', 'wt-m');
    r.g(r.dir, 'worktree', 'add', '-q', '-b', 'spec/m', wt);
    fs.rmSync(path.join(wt, SPEC), { force: true });
    expect(doc(resolveDoc(project(), `.worktrees/wt-m/${SPEC}`))).toMatchObject({ source: 'main', note: 'The worktree "wt-m" does not have this file; this is the main checkout copy.' });
    r.g(r.dir, 'worktree', 'remove', '--force', wt);
    expect(doc(resolveDoc(project(), `.worktrees/wt-m/${SPEC}`))).toMatchObject({ source: 'main', markdown: 'main copy', note: 'The worktree "wt-m" is gone; this is the main checkout copy.' });
  });

  it('a folder that is not a git repo: on disk only, vsMain unknown', () => {
    r = makeRepo();
    fs.rmSync(path.join(r.dir, '.git'), { recursive: true, force: true });
    r.write(SPEC, 'plain');
    expect(doc(resolveDoc(project(), SPEC))).toMatchObject({ source: 'main', vsMain: 'unknown' });
  });
});

describe('resolveDoc: an explicitly named copy wins over the main checkout', () => {
  /** main has v1; worktree `a` on `spec/a` has v2 on disk. */
  const setup = () => {
    r = makeRepo();
    r.write(SPEC, 'v1'); r.commit('init');
    const wt = path.join(r.dir, '.worktrees', 'a');
    r.g(r.dir, 'worktree', 'add', '-q', '-b', 'spec/a', wt);
    fs.writeFileSync(path.join(wt, SPEC), 'v2');
    return wt;
  };

  it('a named worktree returns its copy', () => {
    const wt = setup();
    const d = doc(resolveDoc(project(), SPEC, { worktree: 'a' }));
    expect(d).toMatchObject({ source: 'worktree', worktree: 'a', branch: 'spec/a', markdown: 'v2', vsMain: 'changed', path: SPEC });
    expect(d.absPath).toBe(path.join(wt, SPEC));
  });

  it('a named branch that a worktree has checked out returns the worktree copy on disk', () => {
    setup();
    expect(doc(resolveDoc(project(), SPEC, { branch: 'spec/a' }))).toMatchObject({ source: 'worktree', worktree: 'a', markdown: 'v2' });
  });

  it('a remote branch whose local name a worktree has checked out returns the worktree copy', () => {
    setup();
    r.g(r.dir, 'remote', 'add', 'origin', r.dir);
    r.g(r.dir, 'update-ref', 'refs/remotes/origin/spec/a', 'HEAD');
    expect(doc(resolveDoc(project(), SPEC, { branch: 'origin/spec/a' }))).toMatchObject({ source: 'worktree', worktree: 'a', markdown: 'v2' });
  });

  it('a named branch with no worktree that changed the file returns the blob', () => {
    setup();
    r.g(r.dir, 'checkout', '-q', '-b', 'spec/c');
    r.write(SPEC, 'v3'); r.commit('c');
    r.g(r.dir, 'checkout', '-q', 'main');
    expect(doc(resolveDoc(project(), SPEC, { branch: 'spec/c' }))).toMatchObject({ source: 'branch', branch: 'spec/c', absPath: null, markdown: 'v3', vsMain: 'changed' });
  });

  it('an unknown worktree name, an unlisted branch, or a named copy without the file falls back to the main copy', () => {
    setup();
    r.g(r.dir, 'branch', 'spec/empty');
    r.write('docs/other.md', 'main other'); r.commit('other');
    expect(doc(resolveDoc(project(), SPEC, { worktree: 'nope' }))).toMatchObject({ source: 'main', markdown: 'v1' });
    expect(doc(resolveDoc(project(), SPEC, { branch: 'no-such-branch' }))).toMatchObject({ source: 'main', markdown: 'v1' });
    expect(doc(resolveDoc(project(), SPEC, { branch: '--output=/tmp/x' }))).toMatchObject({ source: 'main', markdown: 'v1' });
    expect(doc(resolveDoc(project(), 'docs/other.md', { worktree: 'a' }))).toMatchObject({ source: 'main', markdown: 'main other' });
    expect(doc(resolveDoc(project(), 'docs/other.md', { branch: 'spec/empty' }))).toMatchObject({ source: 'main', markdown: 'main other' });
  });

  it('a named branch that the main checkout has checked out reads the live file, not the blob', () => {
    setup();
    fs.writeFileSync(path.join(r.dir, SPEC), 'live edit');
    for (const ref of [SPEC, path.join(r.dir, SPEC)]) {
      const d = doc(resolveDoc(project(), ref, { branch: 'main' }));
      expect(d).toMatchObject({ source: 'main', markdown: 'live edit' });
      expect(d.absPath).not.toBeNull();
    }
    r.g(r.dir, 'remote', 'add', 'origin', r.dir);
    r.g(r.dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    expect(doc(resolveDoc(project(), SPEC, { branch: 'origin/main' }))).toMatchObject({ source: 'main', markdown: 'live edit' });
  });

  it('a named worktree copy still obeys the safety rules', () => {
    const wt = setup();
    fs.writeFileSync(path.join(r.root, 'secret.md'), 's');
    fs.rmSync(path.join(wt, SPEC));
    fs.symlinkSync(path.join(r.root, 'secret.md'), path.join(wt, SPEC));
    expect(resolveDoc(project(), SPEC, { worktree: 'a' }).kind).toBe('refused');
    fs.rmSync(path.join(wt, SPEC));
    fs.writeFileSync(path.join(wt, SPEC), 'x'.repeat(DOC_MAX_BYTES + 1));
    expect(resolveDoc(project(), SPEC, { worktree: 'a' }).kind).toBe('too_large');
  });
});

describe('resolveDoc safety', () => {
  it('refuses ../, an absolute path outside, and a symlink out', () => {
    r = makeRepo();
    r.write('README.md', 'x'); r.commit('init');
    fs.writeFileSync(path.join(r.root, 'secret.md'), 's');
    fs.mkdirSync(path.join(r.dir, 'docs'), { recursive: true });
    fs.symlinkSync(path.join(r.root, 'secret.md'), path.join(r.dir, 'docs', 'link.md'));
    expect(resolveDoc(project(), '../secret.md').kind).toBe('refused');
    expect(resolveDoc(project(), path.join(r.root, 'secret.md')).kind).toBe('refused');
    expect(resolveDoc(project(), 'docs/link.md').kind).toBe('refused');
  });
  it('refuses other file types and a folder', () => {
    r = makeRepo();
    r.write('docs/a.json', '{}'); r.write('docs/dir.md/x.md', 'x'); r.commit('init');
    expect(resolveDoc(project(), 'docs/a.json').kind).toBe('refused');
    expect(resolveDoc(project(), 'docs/dir.md').kind).toBe('refused');
  });
  it('a worktree outside the project folder is not used', () => {
    r = makeRepo();
    r.write('README.md', 'x'); r.commit('init');
    const outside = path.join(r.root, 'elsewhere');
    r.g(r.dir, 'worktree', 'add', '-q', '-b', 'spec/out', outside);
    r.write(SPEC, 'o', outside);
    expect(resolveDoc(project(), SPEC).kind).toBe('not_found');
  });
  it('ignores a branch the server did not list, and a branch named like an option', () => {
    r = makeRepo();
    r.write('README.md', 'x'); r.commit('init');
    expect(resolveDoc(project(), `.worktrees/x/${SPEC}`, { branch: '--output=/tmp/x' }).kind).toBe('not_found');
    expect(resolveDoc(project(), `.worktrees/x/${SPEC}`, { branch: 'no-such-branch' }).kind).toBe('not_found');
  });
  it('refuses a path with a backslash', () => {
    r = makeRepo();
    r.write('README.md', 'x'); r.commit('init');
    expect(resolveDoc(project(), 'docs\\..\\..\\x.md').kind).toBe('refused');
  });
  it('refs() drops a ref name that starts with a dash', () => {
    r = makeRepo();
    r.write('README.md', 'x'); r.commit('init');
    try { r.g(r.dir, 'update-ref', 'refs/heads/-x', 'HEAD'); } catch { /* git refused to create it: the filter is still kept */ }
    expect(refs(r.dir).some((k) => k.name.startsWith('-'))).toBe(false);
  });
  it('ignores a stale origin/HEAD that points at a branch that does not exist', () => {
    r = makeRepo();
    r.write(SPEC, 'm'); r.commit('init');
    r.g(r.dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/gone');
    expect(doc(resolveDoc(project(), SPEC)).vsMain).toBe('same');
  });
  it('a symlink inside the project to another kind of file is refused', () => {
    r = makeRepo();
    r.write('docs/data.json', '{}'); r.commit('init');
    fs.symlinkSync(path.join(r.dir, 'docs', 'data.json'), path.join(r.dir, 'docs', 'data.md'));
    expect(resolveDoc(project(), 'docs/data.md').kind).toBe('refused');
  });
  it('a project folder inside a bigger repo never reads that repo\'s branches (their paths start outside the folder)', () => {
    r = makeRepo();
    r.write('sub/README.md', 'x'); r.commit('init');
    r.g(r.dir, 'checkout', '-q', '-b', 'spec/p');
    r.write('docs/x.md', 'parent'); r.commit('p');
    r.g(r.dir, 'checkout', '-q', 'main');
    expect(resolveDoc({ id: 's1', folder: path.join(r.dir, 'sub') }, 'docs/x.md').kind).toBe('not_found');
  });
  it('a file over 2 MB on disk and a blob over 2 MB on a branch are too large', () => {
    r = makeRepo();
    r.write('README.md', 'x'); r.commit('init');
    r.write('docs/big.md', 'x'.repeat(DOC_MAX_BYTES + 1));
    expect(resolveDoc(project(), 'docs/big.md').kind).toBe('too_large');
    r.g(r.dir, 'checkout', '-q', '-b', 'spec/big');
    r.write('docs/bigb.md', 'x'.repeat(DOC_MAX_BYTES + 1)); r.commit('big');
    r.g(r.dir, 'checkout', '-q', 'main');
    fs.rmSync(path.join(r.dir, 'docs', 'big.md'), { force: true }); // the branch commit took it along
    expect(resolveDoc(project(), 'docs/bigb.md').kind).toBe('too_large');
  });
});

describe('resolveDoc: the branch scan is bounded', () => {
  /** A branch off main with one commit at committer time `secs`. */
  const branchAt = (name: string, secs: number, files: Record<string, string>) => {
    r.g(r.dir, 'checkout', '-q', '-b', name, 'main');
    for (const [f, text] of Object.entries(files)) r.write(f, text);
    r.g(r.dir, 'add', '-A');
    execFileSync('git', ['commit', '-q', '-m', name], { cwd: r.dir, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_COMMITTER_DATE: `@${secs} +0000` } });
    r.g(r.dir, 'checkout', '-q', 'main');
  };
  /** 25 unmerged branches b00 (oldest) to b24 (newest); only `withDoc` has the spec. */
  const many = (withDoc: number) => {
    r = makeRepo();
    r.write('README.md', 'x'); r.commit('init');
    for (let i = 0; i < 25; i++) {
      const n = `b${String(i).padStart(2, '0')}`;
      branchAt(n, 1_700_000_000 + i * 60, i === withDoc ? { [SPEC]: n } : { [`docs/n-${i}.md`]: n });
    }
  };

  it('an unmerged branch older than the newest 20 is not read', () => {
    many(0);
    const res = resolveDoc(project(), SPEC);
    expect(res.kind).toBe('not_found');
    if (res.kind === 'not_found') expect(res.looked).not.toContain(`b00:${SPEC}`);
  });

  it('the 3rd newest unmerged branch is read', () => {
    many(22);
    expect(doc(resolveDoc(project(), SPEC))).toMatchObject({ source: 'branch', branch: 'b22', markdown: 'b22' });
  });

  it('a branch tried as the named or the name-suffix branch is not tried again', () => {
    r = makeRepo();
    r.write('README.md', 'x'); r.commit('init');
    const wt = path.join(r.dir, '.worktrees', 'gone');
    r.g(r.dir, 'worktree', 'add', '-q', '-b', 'spec/gone', wt);
    r.write('docs/other.md', 'o', wt); r.commit('other', wt);
    r.g(r.dir, 'worktree', 'remove', '--force', wt);
    for (const res of [resolveDoc(project(), `.worktrees/gone/${SPEC}`, { branch: 'spec/gone' }), resolveDoc(project(), `.worktrees/gone/${SPEC}`), resolveDoc(project(), SPEC, { branch: 'spec/gone' })]) {
      expect(res.kind).toBe('not_found');
      if (res.kind === 'not_found') expect(res.looked).toEqual([...new Set(res.looked)]);
    }
  });
});

describe('git wrapper', () => {
  it('takes no optional lock: --no-optional-locks comes first, before -C', () => {
    expect(gitArgs('/repo', ['status'])).toEqual(['--no-optional-locks', '-C', '/repo', 'status']);
  });
});

describe('statusLine', () => {
  it('the first Status: line in the first 20 lines, max 60 chars', () => {
    expect(statusLine('# T\nDate: x\nStatus: approved\n')).toBe('approved');
    expect(statusLine('# T\n'.repeat(25) + 'Status: late\n')).toBeNull();
    expect(statusLine(`Status: ${'y'.repeat(80)}`)).toHaveLength(60);
  });
});
