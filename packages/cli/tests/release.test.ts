import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
  spawnSync: vi.fn(),
}));

import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { cmdRelease } from '../src/index.js';

let repoRoot: string;
let calls: Array<{ cmd: string; args: string[] }>;

/** A repo that satisfies every guard, so each test can break exactly one thing. */
function goodRepo(version = '2.11.0'): void {
  fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({ version }));
  for (const pkg of ['cli', 'core', 'web']) {
    fs.mkdirSync(path.join(repoRoot, 'packages', pkg), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'packages', pkg, 'package.json'), JSON.stringify({ version }));
  }
  fs.mkdirSync(path.join(repoRoot, 'docs', 'releases'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'docs', 'releases', `v${version}.md`), `# Dispatch v${version}\n\nThe change.\n`);
}

/** git/gh responses that put the tree in a releasable state. */
function wireGit(): void {
  vi.mocked(execFileSync).mockImplementation(((cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    if (cmd !== 'git') return '';
    if (args[0] === 'status') return '';
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'main\n';
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return 'deadbeef\n';
    if (args[0] === 'rev-parse' && args[1] === 'origin/main') return 'deadbeef\n';
    if (args[0] === 'tag' && args[1] === '-l') return 'v2.10.0\n';
    return '';
  }) as any);
  // `gh --version` succeeds; `git rev-parse <tag>` fails, i.e. the tag is free.
  vi.mocked(spawnSync).mockImplementation(((cmd: string) => (
    cmd === 'gh' ? { status: 0, stdout: 'gh 2.0.0', stderr: '' } : { status: 1, stdout: '', stderr: '' }
  )) as any);
}

function ghReleaseCall() {
  return calls.find((c) => c.cmd === 'gh' && c.args[0] === 'release' && c.args[1] === 'create');
}

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-release-'));
  calls = [];
  wireGit();
  goodRepo();
});
afterEach(() => {
  try { fs.rmSync(repoRoot, { recursive: true, force: true }); } catch {}
  vi.mocked(execFileSync).mockReset();
  vi.mocked(spawnSync).mockReset();
  vi.restoreAllMocks();
});

describe('dispatch release — release-note guard', () => {
  test('refuses when docs/releases/vX.Y.Z.md is missing', () => {
    fs.rmSync(path.join(repoRoot, 'docs', 'releases', 'v2.11.0.md'));
    expect(() => cmdRelease({ repoRoot } as any, ['2.11.0'])).toThrow(/docs\/releases\/v2\.11\.0\.md/);
    expect(ghReleaseCall()).toBeUndefined();
  });

  test('refuses when the note file exists but is empty', () => {
    fs.writeFileSync(path.join(repoRoot, 'docs', 'releases', 'v2.11.0.md'), '\n  \n');
    expect(() => cmdRelease({ repoRoot } as any, ['2.11.0'])).toThrow(/empty/i);
  });

  test('publishes the note as the GitHub Release body via --notes-file', () => {
    cmdRelease({ repoRoot } as any, ['2.11.0']);
    const gh = ghReleaseCall()!;
    expect(gh.args).toContain('--notes-file');
    expect(gh.args[gh.args.indexOf('--notes-file') + 1]).toBe(path.join(repoRoot, 'docs', 'releases', 'v2.11.0.md'));
    // The old auto-generated commit list is gone — that is what made notes unreadable.
    expect(gh.args).not.toContain('--generate-notes');
  });

  test('names the release after the tag — --notes-file sets no title on its own', () => {
    cmdRelease({ repoRoot } as any, ['2.11.0']);
    const gh = ghReleaseCall()!;
    expect(gh.args[gh.args.indexOf('--title') + 1]).toBe('v2.11.0');
  });

  test('tags and pushes before creating the release', () => {
    cmdRelease({ repoRoot } as any, ['2.11.0']);
    expect(calls.map((c) => `${c.cmd} ${c.args.slice(0, 2).join(' ')}`)).toEqual(
      expect.arrayContaining(['git tag -a', 'git push origin', 'gh release create']),
    );
  });

  test('accepts a version given with or without the v prefix', () => {
    cmdRelease({ repoRoot } as any, ['v2.11.0']);
    expect(ghReleaseCall()!.args[2]).toBe('v2.11.0');
  });
});

describe('dispatch release — package.json guard', () => {
  test('refuses when package.json still carries the previous version', () => {
    goodRepo('2.11.0');
    fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({ version: '2.10.0' }));
    expect(() => cmdRelease({ repoRoot } as any, ['2.11.0'])).toThrow(/package\.json/);
    expect(ghReleaseCall()).toBeUndefined();
  });

  test('the error names both versions, so the fix is obvious', () => {
    fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({ version: '2.10.0' }));
    expect(() => cmdRelease({ repoRoot } as any, ['2.11.0'])).toThrow(/2\.10\.0[\s\S]*2\.11\.0|2\.11\.0[\s\S]*2\.10\.0/);
  });

  // The daemon reports its version from packages/core/package.json (update/version.ts),
  // NOT the root one. v2.31.0 shipped with only the root bumped: the update applied,
  // the daemon restarted on the new code, and then kept announcing the update forever
  // because core still said 2.30.1. Every one of the four files must carry the version.
  test('refuses when packages/core/package.json lags — the daemon reads THAT file', () => {
    fs.writeFileSync(path.join(repoRoot, 'packages', 'core', 'package.json'), JSON.stringify({ version: '2.10.0' }));
    expect(() => cmdRelease({ repoRoot } as any, ['2.11.0'])).toThrow(/packages\/core\/package\.json/);
    expect(ghReleaseCall()).toBeUndefined();
  });

  test('refuses when packages/cli or packages/web lag, and names every laggard', () => {
    fs.writeFileSync(path.join(repoRoot, 'packages', 'cli', 'package.json'), JSON.stringify({ version: '2.10.0' }));
    fs.writeFileSync(path.join(repoRoot, 'packages', 'web', 'package.json'), JSON.stringify({ version: '2.9.0' }));
    expect(() => cmdRelease({ repoRoot } as any, ['2.11.0']))
      .toThrow(/packages\/cli\/package\.json[\s\S]*packages\/web\/package\.json/);
  });
});

describe('dispatch release — existing guards still hold', () => {
  test('refuses a dirty working tree before it looks at anything else', () => {
    vi.mocked(execFileSync).mockImplementation(((cmd: string, args: string[]) => (
      cmd === 'git' && args[0] === 'status' ? ' M packages/core/src/x.ts\n' : ''
    )) as any);
    expect(() => cmdRelease({ repoRoot } as any, ['2.11.0'])).toThrow(/uncommitted/i);
  });

  test('refuses when the tag already exists', () => {
    vi.mocked(spawnSync).mockImplementation((() => ({ status: 0, stdout: '', stderr: '' })) as any);
    expect(() => cmdRelease({ repoRoot } as any, ['2.11.0'])).toThrow(/already exists/i);
  });
});
