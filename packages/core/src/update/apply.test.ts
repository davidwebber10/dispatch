import { describe, it, expect, vi, afterEach } from 'vitest';
import { preflightUpdate, parsePorcelain, type GitExec } from './apply.js';
import { fakeGit, release, exit } from './fake-git.fixture.js';

afterEach(() => { vi.restoreAllMocks(); });

/** GitHub's answer: the releases published. */
const github = (...tags: string[]) => vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => tags.map((t) => release(t)) }) as any;

/** v3.5.0 is released and on main at def456; this checkout (abc123) is one commit behind it. */
const world = { tags: { 'v3.4.0': 'old340', 'v3.5.0': 'def456', 'v3.6.0': 'unreleased' }, main: ['old340', 'def456', 'abc123'], head: 'abc123', ancestors: { def456: ['abc123'] } };
const RELEASES = ['v3.4.0', 'v3.5.0'];

describe('preflightUpdate: the reason never carries a path (SEC sweep)', () => {
  // execFileSync's message is "Command failed: git -C <repo> <args>" plus git's stderr: both name folders.
  const leaky = new Error("Command failed: git -C /Users/someone/dispatch fetch origin\nfatal: '/Users/someone/remote.git' does not appear to be a git repository\n");
  for (const step of ['status', 'fetch', 'ls-remote', 'rev-parse']) {
    it(`a failed "git ${step}" gives a plain reason`, async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const inner = fakeGit(world);
      const git: GitExec = (args) => { if (args[0] === step) throw leaky; return inner(args); };
      const result = await preflightUpdate('/Users/someone/dispatch', git, { version: '3.4.0', fetchImpl: github(...RELEASES) });
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/failed|could not/i);
      expect(result.reason).not.toMatch(/\/Users|someone|Command failed/);
    });
  }
});

describe('preflightUpdate', () => {
  const run = (w: object, o: object = {}, tags: string[] = RELEASES) =>
    preflightUpdate('/repo', fakeGit({ ...world, ...w }), { version: '3.4.0', fetchImpl: github(...tags), ...o });

  it('fails when the working tree is dirty', async () => {
    const result = await run({ dirty: ' M packages/core/src/server.ts\n' });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/uncommitted changes/i);
  });

  it('succeeds on a clean, fast-forwardable tree', async () => {
    expect(await run({})).toEqual({ ok: true, move: 'forward' });
  });

  it('fails when the local branch has diverged from the release (cannot fast-forward)', async () => {
    const result = await run({ head: 'mine', ancestors: {} });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/diverged/i);
    expect(result.forceable).toBeFalsy();
    // Not stuck: the explicit switch lifts it (LR-2).
    expect(result.needsSwitchBack).toBe(true);
    expect(await run({ head: 'mine', ancestors: {} }, { switchBack: true })).toEqual({ ok: true, move: 'back' });
  });

  it('a dirty tree with the explicit switch gets the move-back message, not the forward "update anyway" advice', async () => {
    const result = await run({ head: 'mine', ancestors: {}, dirty: ' M a.ts\n' }, { switchBack: true });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/clean working tree/);
    expect(result.reason).not.toMatch(/update anyway/);
    expect(result.forceable).toBeFalsy();
  });

  it('the explicit switch does not skip the dirty gate of a plain forward update', async () => {
    const result = await run({ dirty: ' M a.ts\n' }, { switchBack: true });
    expect(result.ok).toBe(false);
    expect(result.forceable).toBe(true);
  });

  it('succeeds when already up to date', async () => {
    expect(await run({ head: 'def456' }, { version: '3.5.0' })).toEqual({ ok: true, move: 'current' });
  });

  it('fails when git fetch itself fails (e.g. offline)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await run({ fetchFails: true });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/could not read the release tags/i);
  });

  it('reports parsed dirty entries and marks the failure forceable', async () => {
    const result = await run({ dirty: ' M packages/core/src/server.ts\n?? scratch.txt\nR  old.ts -> new.ts\n' });
    expect(result.ok).toBe(false);
    expect(result.forceable).toBe(true);
    expect(result.dirty).toEqual([
      { status: ' M', path: 'packages/core/src/server.ts' },
      { status: '??', path: 'scratch.txt' },
      { status: 'R ', path: 'old.ts -> new.ts' },
    ]);
    expect(result.dirtyOverflow).toBe(0);
  });

  it('force:true skips the dirty gate of a forward update', async () => {
    expect(await run({ dirty: ' M a.ts\n' }, { force: true })).toEqual({ ok: true, move: 'forward' });
  });

  it('force:true does NOT skip the move check — a diverged branch is never forceable', async () => {
    const result = await run({ dirty: ' M a.ts\n', head: 'mine', ancestors: {} }, { force: true });
    expect(result.ok).toBe(false);
    expect(result.forceable).toBeFalsy();
    expect(result.reason).toMatch(/diverged/i);
  });

  it('updates to the newest PUBLISHED release, never a higher tag nobody released', async () => {
    // v3.6.0 is a tag on origin with no release: it must not be the target. Had it been, this checkout
    // (running 3.4.0, behind v3.5.0 only) could not fast-forward to it and the preflight would refuse.
    expect(await run({})).toEqual({ ok: true, move: 'forward' });
  });

  it('ignores drafts and prereleases', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [release('v3.5.0'), release('v3.6.0', { draft: true }), release('v3.7.0', { prerelease: true })] }) as any;
    expect(await preflightUpdate('/repo', fakeGit({ ...world, tags: { ...world.tags, 'v3.7.0': 'x' }, main: [...world.main, 'unreleased', 'x'] }), { version: '3.4.0', fetchImpl })).toEqual({ ok: true, move: 'forward' });
  });

  it('stops clearly when GitHub cannot be reached, and does not pick the highest tag', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await run({}, { fetchImpl: vi.fn().mockRejectedValue(new Error('offline')) });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/reach GitHub/);
  });

  it('stops clearly when no release is on main', async () => {
    const result = await run({ main: ['abc123'] });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/No published release on main/);
    expect(result.forceable).toBeFalsy();
  });

  it('is fine when the checkout is a dev checkout of main past the release (same version)', async () => {
    const result = await run({ head: 'tip', ancestors: { tip: ['def456'] } }, { version: '3.5.0' });
    expect(result).toEqual({ ok: true, move: 'current' });
  });

  describe('running ahead of the newest release (stuck on an unreleased tag)', () => {
    const ahead = { head: 'x40', ancestors: {} };

    it('is refused without the explicit switch, and says so', async () => {
      const result = await run(ahead, { version: '3.6.0' });
      expect(result.ok).toBe(false);
      expect(result.needsSwitchBack).toBe(true);
      expect(result.reason).toMatch(/3\.6\.0.*3\.5\.0/s);
    });

    it('passes with the explicit switch and says the move is back', async () => {
      expect(await run(ahead, { version: '3.6.0', switchBack: true })).toEqual({ ok: true, move: 'back' });
    });

    it('a dirty tree is never forceable for a move back', async () => {
      const result = await run({ ...ahead, dirty: ' M a.ts\n' }, { version: '3.6.0', switchBack: true, force: true });
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/clean working tree/);
      expect(result.forceable).toBeFalsy();
    });
  });

  it('an untracked-only tree parses correctly', async () => {
    const result = await run({ dirty: '?? scratch.txt\n?? notes.md\n' });
    expect(result.ok).toBe(false);
    expect(result.forceable).toBe(true);
    expect(result.dirty).toEqual([
      { status: '??', path: 'scratch.txt' },
      { status: '??', path: 'notes.md' },
    ]);
  });
});

describe('parsePorcelain', () => {
  it('parses each row into a status/path pair, keeping renames intact', () => {
    const status = ' M packages/core/src/server.ts\n?? scratch.txt\nR  old.ts -> new.ts\n';
    const { entries, overflow } = parsePorcelain(status);
    expect(entries).toEqual([
      { status: ' M', path: 'packages/core/src/server.ts' },
      { status: '??', path: 'scratch.txt' },
      { status: 'R ', path: 'old.ts -> new.ts' },
    ]);
    expect(overflow).toBe(0);
  });

  it('caps at 50 entries and counts the overflow', () => {
    const many = Array.from({ length: 60 }, (_, i) => `?? f${i}.txt`).join('\n');
    const { entries, overflow } = parsePorcelain(many);
    expect(entries).toHaveLength(50);
    expect(overflow).toBe(10);
  });
});
