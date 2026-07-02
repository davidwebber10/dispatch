import { describe, it, expect } from 'vitest';
import { preflightUpdate, type GitExec } from './apply.js';

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
});
