import { describe, it, expect } from 'vitest';
import { preflightUpdate, parsePorcelain, type GitExec } from './apply.js';

/** Builds a fake `git` runner from a map of `args.join(' ')` -> stdout (or a thrown Error). */
function fakeGit(responses: Record<string, string | Error>): GitExec {
  return (args) => {
    const key = args.join(' ');
    const res = responses[key];
    if (res === undefined) throw new Error(`unexpected git invocation: ${key}`);
    if (res instanceof Error) throw res;
    return res;
  };
}

const CLEAN_AND_FF_ABLE = {
  'status --porcelain': '',
  'fetch origin': '',
  'rev-parse --abbrev-ref HEAD': 'main\n',
  'rev-parse HEAD': 'abc123\n',
  'rev-parse origin/main': 'def456\n',
  'merge-base --is-ancestor abc123 def456': '',
};

describe('preflightUpdate', () => {
  it('fails when the working tree is dirty', () => {
    const git = fakeGit({ ...CLEAN_AND_FF_ABLE, 'status --porcelain': ' M packages/core/src/server.ts\n' });
    const result = preflightUpdate('/repo', git);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/uncommitted changes/i);
  });

  it('succeeds on a clean, fast-forwardable tree', () => {
    const git = fakeGit(CLEAN_AND_FF_ABLE);
    const result = preflightUpdate('/repo', git);
    expect(result).toEqual({ ok: true });
  });

  it('fails when the local branch has diverged from origin (cannot fast-forward)', () => {
    const git = fakeGit({
      ...CLEAN_AND_FF_ABLE,
      'merge-base --is-ancestor abc123 def456': new Error('exit code 1'),
    });
    const result = preflightUpdate('/repo', git);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/diverged/i);
    expect(result.forceable).toBeFalsy();
  });

  it('succeeds when already up to date (local HEAD == origin HEAD, an ancestor of itself)', () => {
    const git = fakeGit({
      ...CLEAN_AND_FF_ABLE,
      'rev-parse HEAD': 'abc123\n',
      'rev-parse origin/main': 'abc123\n',
      'merge-base --is-ancestor abc123 abc123': '',
    });
    const result = preflightUpdate('/repo', git);
    expect(result).toEqual({ ok: true });
  });

  it('fails when git fetch itself fails (e.g. offline)', () => {
    const git = fakeGit({ ...CLEAN_AND_FF_ABLE, 'fetch origin': new Error('could not resolve host') });
    const result = preflightUpdate('/repo', git);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/git fetch failed/i);
  });

  it('reports parsed dirty entries and marks the failure forceable', () => {
    const git = fakeGit({
      ...CLEAN_AND_FF_ABLE,
      'status --porcelain': ' M packages/core/src/server.ts\n?? scratch.txt\nR  old.ts -> new.ts\n',
    });
    const result = preflightUpdate('/repo', git);
    expect(result.ok).toBe(false);
    expect(result.forceable).toBe(true);
    expect(result.dirty).toEqual([
      { status: ' M', path: 'packages/core/src/server.ts' },
      { status: '??', path: 'scratch.txt' },
      { status: 'R ', path: 'old.ts -> new.ts' },
    ]);
    expect(result.dirtyOverflow).toBe(0);
  });

  it('force:true skips the dirty gate and proceeds through fetch/branch/ancestor checks', () => {
    const calls: string[][] = [];
    const git: GitExec = (args) => {
      calls.push(args);
      const key = args.join(' ');
      if (key === 'status --porcelain') return ' M packages/core/src/server.ts\n';
      return (CLEAN_AND_FF_ABLE as Record<string, string>)[key] ?? '';
    };
    const result = preflightUpdate('/repo', git, { force: true });
    expect(result.ok).toBe(true);
    expect(calls.some((c) => c.join(' ') === 'fetch origin')).toBe(true);
  });

  it('force:true does NOT skip the fast-forward/ancestor check — a diverged branch is never forceable', () => {
    const git = fakeGit({
      ...CLEAN_AND_FF_ABLE,
      'status --porcelain': ' M packages/core/src/server.ts\n',
      'merge-base --is-ancestor abc123 def456': new Error('exit code 1'),
    });
    const result = preflightUpdate('/repo', git, { force: true });
    expect(result.ok).toBe(false);
    expect(result.forceable).toBeFalsy();
    expect(result.reason).toMatch(/diverged/i);
  });

  it('an untracked-only tree parses correctly', () => {
    const git = fakeGit({ ...CLEAN_AND_FF_ABLE, 'status --porcelain': '?? scratch.txt\n?? notes.md\n' });
    const result = preflightUpdate('/repo', git);
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
