import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  eligibleReleases, fetchReleaseList, loadEligibleReleases, moveToTarget, planMove, readMainView, resolveTarget,
  MoveRefused, ReleaseSourceError, type GitExec, type ReleaseTarget,
} from './target.js';
import { fakeGit, exit, release } from './fake-git.fixture.js';

afterEach(() => { vi.restoreAllMocks(); });

const target = (version: string, commit: string): ReleaseTarget => ({ tag: `v${version}`, version, commit, url: '', publishedAt: '' });

describe('readMainView', () => {
  it('fetches main and reads origin\'s tags; a peeled commit wins over the tag object', async () => {
    const git = fakeGit({ tags: { 'v1.0.0': 'c100' }, main: ['c100'] });
    const view = await readMainView(git);
    expect(view.tagCommits.get('v1.0.0')).toBe('c100');
    expect(git.calls[0]).toEqual(['fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
    expect(git.calls[1]).toEqual(['ls-remote', '--tags', 'origin']);
    expect(await view.onMain('c100')).toBe(true);
    expect(await view.onMain('other')).toBe(false);
  });

  it('a lightweight tag (no peeled line) uses the line it has', async () => {
    const git = ((args: string[]) => (args[0] === 'ls-remote' ? 'abc\trefs/tags/v1.0.0\n' : '')) as GitExec;
    expect((await readMainView(git)).tagCommits.get('v1.0.0')).toBe('abc');
  });

  it('works with a git that answers asynchronously (the daemon\'s background check)', async () => {
    const inner = fakeGit({ tags: { 'v1.0.0': 'c100' }, main: ['c100'] });
    const view = await readMainView(async (args) => inner(args));
    expect(view.tagCommits.get('v1.0.0')).toBe('c100');
    expect(await view.onMain('c100')).toBe(true);
  });

  it('stops with a plain message when git cannot read origin', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(readMainView(fakeGit({ fetchFails: true }))).rejects.toThrow(ReleaseSourceError);
  });
});

describe('eligibleReleases', () => {
  const git = fakeGit({
    tags: { 'v1.0.0': 'a', 'v1.1.0': 'b', 'v1.2.0': 'c', 'v1.3.0': 'd', 'v1.4.0-rc1': 'e', 'v9.9.9': 'f' },
    main: ['a', 'b', 'c', 'e'],
  });
  const viewP = readMainView(git);

  it('keeps published releases whose tag commit is on main, newest first', async () => {
    const out = (await eligibleReleases([release('v1.0.0'), release('v1.2.0'), release('v1.1.0')], await viewP));
    expect(out.map((r) => r.tag_name)).toEqual(['v1.2.0', 'v1.1.0', 'v1.0.0']);
    expect(out[0].commit).toBe('c');
  });

  it('ignores a higher TAG that has no published release (the 4.8.0 case)', async () => {
    expect((await eligibleReleases([release('v1.0.0')], await viewP)).map((r) => r.tag_name)).toEqual(['v1.0.0']);
  });

  it('ignores drafts and prereleases', async () => {
    const out = (await eligibleReleases([release('v1.0.0'), release('v1.1.0', { draft: true }), release('v1.2.0', { prerelease: true })], await viewP));
    expect(out.map((r) => r.tag_name)).toEqual(['v1.0.0']);
  });

  it('ignores a release whose tag commit is not on main', async () => {
    expect((await eligibleReleases([release('v1.0.0'), release('v1.3.0')], await viewP)).map((r) => r.tag_name)).toEqual(['v1.0.0']);
  });

  it('ignores a release whose tag no longer exists on origin', async () => {
    expect((await eligibleReleases([release('v1.0.0'), release('v7.7.7')], await viewP)).map((r) => r.tag_name)).toEqual(['v1.0.0']);
  });

  it('ignores tags that are not plain vX.Y.Z, even when published and on main', async () => {
    expect((await eligibleReleases([release('v1.4.0-rc1'), release('nightly')], await viewP))).toEqual([]);
  });

  it('never offers a box build (box-<base>-<n>), even when published and on main', async () => {
    const boxGit = fakeGit({ tags: { 'v1.0.0': 'a', 'box-1.0.0-1': 'b', 'v1.0.0-box.1': 'b' }, main: ['a', 'b'] });
    const out = await eligibleReleases([release('v1.0.0'), release('box-1.0.0-1'), release('v1.0.0-box.1')], await readMainView(boxGit));
    expect(out.map((r) => r.tag_name)).toEqual(['v1.0.0']);
  });
});

describe('fetchReleaseList', () => {
  const res = (body: unknown, ok = true, status = 200) => ({ ok, status, json: async () => body }) as unknown as Response;

  it('returns the list GitHub sends', async () => {
    const list = await fetchReleaseList({ fetchImpl: vi.fn().mockResolvedValue(res([release('v1.0.0')])) as any });
    expect(list).toHaveLength(1);
  });

  it('follows pages until a short one, so an eligible release past page one is found', async () => {
    const page = (n: number) => Array.from({ length: n }, (_, i) => release(`v9.${i}.0`));
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(res(page(2)))
      .mockResolvedValueOnce(res([release('v1.0.0')])) as any;
    const list = await fetchReleaseList({ fetchImpl, perPage: 2 });
    expect(list.map((r) => r.tag_name)).toEqual(['v9.0.0', 'v9.1.0', 'v1.0.0']);
    expect(fetchImpl.mock.calls.map((c: any[]) => c[0])).toEqual([
      expect.stringContaining('per_page=2&page=1'), expect.stringContaining('per_page=2&page=2'),
    ]);
  });

  it('stops at three pages', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res([release('v1.0.0'), release('v1.1.0')])) as any;
    await fetchReleaseList({ fetchImpl, perPage: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('a page that fails stops the whole read: no target from half a list', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(res([release('v1.0.0'), release('v1.1.0')]))
      .mockResolvedValueOnce(res({}, false, 502)) as any;
    await expect(fetchReleaseList({ fetchImpl, perPage: 2 })).rejects.toThrow(/502/);
  });

  it('stops when GitHub cannot be reached', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(fetchReleaseList({ fetchImpl: vi.fn().mockRejectedValue(new Error('offline')) as any })).rejects.toThrow(/reach GitHub/);
  });

  it('stops on an error status', async () => {
    await expect(fetchReleaseList({ fetchImpl: vi.fn().mockResolvedValue(res({}, false, 403)) as any })).rejects.toThrow(/403/);
  });

  it('stops on an answer that is not a list', async () => {
    await expect(fetchReleaseList({ fetchImpl: vi.fn().mockResolvedValue(res({ message: 'hi' })) as any })).rejects.toThrow(ReleaseSourceError);
  });
});

describe('resolveTarget', () => {
  const okFetch = (list: unknown[]) => vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => list }) as any;

  it('picks the newest published release on main', async () => {
    const git = fakeGit({ tags: { 'v4.7.8': 'c78', 'v4.8.0': 'c80' }, main: ['c78'] });
    const t = await resolveTarget(git, { fetchImpl: okFetch([release('v4.7.8')]) });
    expect(t).toMatchObject({ tag: 'v4.7.8', version: '4.7.8', commit: 'c78', url: 'https://example.test/v4.7.8' });
  });

  it('never falls back to the highest tag when GitHub fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const git = fakeGit({ tags: { 'v4.7.8': 'c78', 'v4.8.0': 'c80' }, main: ['c78', 'c80'] });
    await expect(resolveTarget(git, { fetchImpl: vi.fn().mockRejectedValue(new Error('offline')) as any })).rejects.toThrow(/reach GitHub/);
  });

  it('stops with a plain message when no release qualifies', async () => {
    const git = fakeGit({ tags: { 'v4.8.0': 'c80' }, main: [] });
    await expect(resolveTarget(git, { fetchImpl: okFetch([release('v4.8.0')]) })).rejects.toThrow(/No published release on main/);
  });

  it('loadEligibleReleases returns the whole eligible list', async () => {
    const git = fakeGit({ tags: { 'v1.0.0': 'a', 'v1.1.0': 'b' }, main: ['a', 'b'] });
    const list = await loadEligibleReleases(git, { fetchImpl: okFetch([release('v1.0.0'), release('v1.1.0')]) });
    expect(list.map((r) => r.tag_name)).toEqual(['v1.1.0', 'v1.0.0']);
  });
});

describe('planMove', () => {
  it('is already there when HEAD is the target', () => {
    expect(planMove(fakeGit({ head: 'c78' }), target('4.7.8', 'c78'), { version: '4.7.8', allowBack: false })).toBe('current');
  });

  it('fast-forwards when HEAD is behind the target', () => {
    const git = fakeGit({ head: 'old', ancestors: { c78: ['old'] } });
    expect(planMove(git, target('4.7.8', 'c78'), { version: '4.7.7', allowBack: false })).toBe('forward');
  });

  it('a dev checkout past the release with the SAME version is not ahead', () => {
    const git = fakeGit({ head: 'tip', ancestors: { tip: ['c78'] } });
    expect(planMove(git, target('4.7.8', 'c78'), { version: '4.7.8', allowBack: false })).toBe('current');
  });

  it('a diverged checkout with a LOWER version is not moved by itself: it needs the explicit switch', () => {
    const git = fakeGit({ head: 'mine', ancestors: {} });
    try {
      planMove(git, target('4.9.0', 'c90'), { version: '4.8.2', allowBack: false });
      throw new Error('should have refused');
    } catch (e) {
      expect(e).toBeInstanceOf(MoveRefused);
      expect((e as MoveRefused).needsSwitchBack).toBe(true);
      expect((e as MoveRefused).message).toMatch(/diverged.*--switch-back/s);
    }
  });

  it('a diverged checkout with a lower version moves with the explicit switch, under the same gates', () => {
    const t = target('4.9.0', 'c90');
    const base = { head: 'mine', ancestors: {} };
    expect(planMove(fakeGit(base), t, { version: '4.8.2', allowBack: true })).toBe('back');
    expect(() => planMove(fakeGit({ ...base, dirty: '?? a.ts\n' }), t, { version: '4.8.2', allowBack: true })).toThrow(/clean working tree/);
    expect(() => planMove(fakeGit({ ...base, branch: 'feat/x' }), t, { version: '4.8.2', allowBack: true })).toThrow(/feat\/x/);
    const git = fakeGit(base);
    expect(moveToTarget(git, t, { version: '4.8.2', allowBack: true }).backup).toBe('dispatch-backup/v4.8.2-mine');
    expect(git.calls).toContainEqual(['reset', '--hard', 'c90']);
  });

  it('running ahead is refused without the explicit switch, and says how to switch', () => {
    const git = fakeGit({ head: 'x80' });
    try {
      planMove(git, target('4.7.8', 'c78'), { version: '4.8.0', allowBack: false });
      throw new Error('should have refused');
    } catch (e) {
      expect(e).toBeInstanceOf(MoveRefused);
      expect((e as MoveRefused).needsSwitchBack).toBe(true);
      expect((e as MoveRefused).message).toMatch(/4\.8\.0.*4\.7\.8.*--switch-back/s);
    }
  });

  it('running ahead moves back when the switch is explicit', () => {
    expect(planMove(fakeGit({ head: 'x80' }), target('4.7.8', 'c78'), { version: '4.8.0', allowBack: true })).toBe('back');
  });

  it('running ahead on a checkout that contains the release moves back too', () => {
    const git = fakeGit({ head: 'x80', ancestors: { x80: ['c78'] } });
    expect(planMove(git, target('4.7.8', 'c78'), { version: '4.8.0', allowBack: true })).toBe('back');
  });

  it('moving back needs a clean tree, and is not forceable', () => {
    const git = fakeGit({ head: 'x80', dirty: ' M a.ts\n' });
    expect(() => planMove(git, target('4.7.8', 'c78'), { version: '4.8.0', allowBack: true })).toThrow(/clean working tree/);
  });

  it('moving back works from main or a detached HEAD, not from another branch', () => {
    const t = target('4.7.8', 'c78');
    expect(planMove(fakeGit({ head: 'x80', branch: 'HEAD' }), t, { version: '4.8.0', allowBack: true })).toBe('back');
    expect(() => planMove(fakeGit({ head: 'x80', branch: 'feat/x' }), t, { version: '4.8.0', allowBack: true })).toThrow(/feat\/x/);
  });
});

describe('moveToTarget', () => {
  it('forward: merges the commit, not a tag name', () => {
    const git = fakeGit({ head: 'old', ancestors: { c78: ['old'] } });
    expect(moveToTarget(git, target('4.7.8', 'c78'), { version: '4.7.7', allowBack: false })).toEqual({ move: 'forward' });
    expect(git.calls).toContainEqual(['merge', '--ff-only', 'c78']);
  });

  it('current: changes nothing', () => {
    const git = fakeGit({ head: 'c78' });
    expect(moveToTarget(git, target('4.7.8', 'c78'), { version: '4.7.8', allowBack: false })).toEqual({ move: 'current' });
    expect(git.calls.some((c) => c[0] === 'merge' || c[0] === 'reset')).toBe(false);
  });

  it('back: keeps a backup branch at the old HEAD first, then resets to the release', () => {
    const git = fakeGit({ head: 'abcdef1234567', ancestors: {} });
    const out = moveToTarget(git, target('4.7.8', 'c78'), { version: '4.8.0', allowBack: true });
    expect(out).toEqual({ move: 'back', backup: 'dispatch-backup/v4.8.0-abcdef1' });
    const branchIdx = git.calls.findIndex((c) => c[0] === 'branch');
    const resetIdx = git.calls.findIndex((c) => c[0] === 'reset');
    expect(git.calls[branchIdx]).toEqual(['branch', 'dispatch-backup/v4.8.0-abcdef1', 'abcdef1234567']);
    expect(git.calls[resetIdx]).toEqual(['reset', '--hard', 'c78']);
    expect(branchIdx).toBeLessThan(resetIdx);
  });

  it('back: reuses a backup branch that already points at exactly this HEAD', () => {
    const git = fakeGit({ head: 'abcdef1234567', existingBranches: { 'dispatch-backup/v4.8.0-abcdef1': 'abcdef1234567' } });
    const out = moveToTarget(git, target('4.7.8', 'c78'), { version: '4.8.0', allowBack: true });
    expect(out.backup).toBe('dispatch-backup/v4.8.0-abcdef1');
    expect(git.calls.some((c) => c[0] === 'branch')).toBe(false);
    expect(git.calls.some((c) => c[0] === 'reset')).toBe(true);
  });

  it('back: a branch of that name that points ELSEWHERE is never trusted: the next free name keeps the real HEAD', () => {
    const git = fakeGit({ head: 'abcdef1234567', existingBranches: { 'dispatch-backup/v4.8.0-abcdef1': 'someothercommit' } });
    const out = moveToTarget(git, target('4.7.8', 'c78'), { version: '4.8.0', allowBack: true });
    expect(out.backup).toBe('dispatch-backup/v4.8.0-abcdef1-2');
    expect(git.calls).toContainEqual(['branch', 'dispatch-backup/v4.8.0-abcdef1-2', 'abcdef1234567']);
    expect(git.calls.findIndex((c) => c[0] === 'branch')).toBeLessThan(git.calls.findIndex((c) => c[0] === 'reset'));
  });

  it('back: the clean-tree check asks for untracked files explicitly (a status.showUntrackedFiles=no setting must not hide them)', () => {
    const git = fakeGit({ head: 'x80' });
    planMove(git, target('4.7.8', 'c78'), { version: '4.8.0', allowBack: true });
    expect(git.calls).toContainEqual(['status', '--porcelain', '--untracked-files=all']);
  });

  it('back: refused moves touch nothing', () => {
    const git = fakeGit({ head: 'x80', dirty: ' M a.ts\n' });
    expect(() => moveToTarget(git, target('4.7.8', 'c78'), { version: '4.8.0', allowBack: true })).toThrow(MoveRefused);
    expect(git.calls.some((c) => c[0] === 'reset' || c[0] === 'branch' || c[0] === 'merge')).toBe(false);
  });
});
