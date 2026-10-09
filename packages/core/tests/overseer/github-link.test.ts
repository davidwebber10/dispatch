// The GitHub link of a PR or issue source (titles and source panel spec 2026-10-09, Unit 5): the
// daemon reads the project's remote, accepts the SSH and HTTPS forms, and builds the link. Any
// other remote, or a git error, gives no link. The remote is cached per project for 10 minutes.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRemoteReader, gitOriginUrl, githubRepoFromRemote, REMOTE_CACHE_MS, sourceUrl } from '../../src/overseer/github-link.js';

describe('githubRepoFromRemote', () => {
  it('the SSH form and the HTTPS form, with or without .git', () => {
    expect(githubRepoFromRemote('git@github.com:owner/repo.git')).toBe('owner/repo');
    expect(githubRepoFromRemote('git@github.com:owner/repo')).toBe('owner/repo');
    expect(githubRepoFromRemote('https://github.com/owner/repo.git')).toBe('owner/repo');
    expect(githubRepoFromRemote('https://github.com/owner/repo')).toBe('owner/repo');
    expect(githubRepoFromRemote('https://github.com/owner/repo/\n')).toBe('owner/repo');
    expect(githubRepoFromRemote('ssh://git@github.com/owner/my.repo.git')).toBe('owner/my.repo');
    expect(githubRepoFromRemote('https://user@github.com/owner/repo.git')).toBe('owner/repo');
  });

  it('a remote that is not on GitHub, or not a remote at all, gives null', () => {
    for (const remote of ['git@gitlab.com:owner/repo.git', 'https://gitlab.com/owner/repo', 'https://github.com.example.org/owner/repo',
      'https://github.com/owner', '/srv/git/repo.git', '', 'https://github.com/owner/repo/tree/main']) {
      expect(githubRepoFromRemote(remote), remote).toBeNull();
    }
  });
});

describe('sourceUrl', () => {
  it('a PR or issue ref "#26" with a GitHub repo', () => {
    expect(sourceUrl('pr', '#26', 'owner/repo')).toBe('https://github.com/owner/repo/pull/26');
    expect(sourceUrl('issue', '#26', 'owner/repo')).toBe('https://github.com/owner/repo/issues/26');
  });

  it('a ref that is already a GitHub URL is used as is, with or without a repo', () => {
    expect(sourceUrl('pr', 'https://github.com/owner/other/pull/9', null)).toBe('https://github.com/owner/other/pull/9');
  });

  it('no repo, another kind, or a ref of another shape gives null', () => {
    expect(sourceUrl('pr', '#26', null)).toBeNull();
    expect(sourceUrl('plan', 'docs/plans/a.md', 'owner/repo')).toBeNull();
    expect(sourceUrl('pr', 'twenty-six', 'owner/repo')).toBeNull();
    expect(sourceUrl('pr', 'http://github.com.evil.example/x', 'owner/repo')).toBeNull();
  });
});

describe('createRemoteReader — the remote, cached per project for 10 minutes', () => {
  it('runs git once per project in 10 minutes, then again', () => {
    let now = 0;
    const calls: string[] = [];
    const read = createRemoteReader({ clock: () => now, run: (dir) => { calls.push(dir); return 'git@github.com:owner/repo.git\n'; } });
    expect(REMOTE_CACHE_MS).toBe(10 * 60_000);
    expect(read('/p1')).toBe('owner/repo');
    expect(read('/p1')).toBe('owner/repo');
    expect(read('/p2')).toBe('owner/repo');
    now = REMOTE_CACHE_MS - 1;
    read('/p1');
    expect(calls).toEqual(['/p1', '/p2']);
    now = REMOTE_CACHE_MS + 1;
    read('/p1');
    expect(calls).toEqual(['/p1', '/p2', '/p1']);
  });

  it('a git error gives null, with no throw, and is cached too', () => {
    let runs = 0;
    const read = createRemoteReader({ clock: () => 0, run: () => { runs++; throw new Error('not a git repository'); } });
    expect(read('/p')).toBeNull();
    expect(read('/p')).toBeNull();
    expect(runs).toBe(1);
  });
});

describe('gitOriginUrl — the real git, in a temporary folder', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-remote-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('reads origin; a folder that is not a repository throws', () => {
    expect(() => gitOriginUrl(dir)).toThrow();
    execFileSync('git', ['-C', dir, 'init', '-q'], { stdio: 'ignore' });
    expect(() => gitOriginUrl(dir)).toThrow(); // no origin yet
    execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'git@github.com:owner/repo.git'], { stdio: 'ignore' });
    expect(gitOriginUrl(dir).trim()).toBe('git@github.com:owner/repo.git');
  });
});

describe('LedgerService.card — the link on the pinned card', () => {
  it('reads the repo of the project folder, only when a PR or issue source is on the ledger', async () => {
    const Database = (await import('better-sqlite3')).default;
    const { initSchema } = await import('../../src/db/schema.js');
    const sessionsDb = await import('../../src/db/sessions.js');
    const ledgerDb = await import('../../src/db/ledger.js');
    const { LedgerService } = await import('../../src/overseer/ledger-service.js');
    const db = new Database(':memory:');
    initSchema(db);
    sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'p', workingDir: '/projects/p' });
    const asked: string[] = [];
    const ledger = new LedgerService(db, { githubRepo: (dir) => { asked.push(dir); return 'owner/repo'; } });
    ledgerDb.create(db, { sessionId: 's1', kind: 'do', text: 'Check staging.', title: 'Check staging', author: 'overseer' });
    ledger.card('s1');
    expect(asked).toEqual([]);
    ledgerDb.create(db, { sessionId: 's1', kind: 'go', text: 'Merge board PR #26?', title: 'Merge board PR #26', author: 'overseer', sourceKind: 'pr', sourceRef: '#26' });
    const card = ledger.card('s1');
    expect(asked).toEqual(['/projects/p']);
    expect(card.sections.needsYou.cards[0].source!.url).toBe('https://github.com/owner/repo/pull/26');
  });
});
