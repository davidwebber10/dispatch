import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { primaryClaudeStateFile, seedAccountClaudeState } from './claude-account-state.js';

/**
 * A new login folder starts with none of Claude Code's first-run state. Seen with a real sign-in on
 * 2026-11-24: the first interactive thread of such an account opened on the theme question, and a
 * message sent to it would have gone into that screen (spec 2026-11-24, a full sign-in for a Claude account).
 */
describe('a new account folder takes over the first-run state of the computer', () => {
  let dir: string;
  let primary: string;
  let account: string;
  const write = (file: string, v: unknown) => fs.writeFileSync(file, JSON.stringify(v));
  const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-state-'));
    primary = path.join(dir, 'primary.json');
    account = path.join(dir, 'acct');
    fs.mkdirSync(account);
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('it copies "onboarding is done" and the folders the person trusts, and nothing else', () => {
    write(primary, {
      hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.72',
      oauthAccount: { emailAddress: 'personal@example.com' }, userID: 'primary-user',
      mcpServers: { secretServer: { env: { TOKEN: 'do-not-copy' } } },
      projects: { '/work/a': { hasTrustDialogAccepted: true, lastCost: 3, allowedTools: ['Bash'] }, '/work/b': { hasTrustDialogAccepted: false }, '/work/c': {} },
    });
    write(path.join(account, '.claude.json'), { oauthAccount: { emailAddress: 'team@example.com' }, userID: 'team-user', migrationVersion: 11 });
    expect(seedAccountClaudeState(account, primary)).toBe(true);
    const got = read(path.join(account, '.claude.json'));
    expect(got).toEqual({
      oauthAccount: { emailAddress: 'team@example.com' }, userID: 'team-user', migrationVersion: 11,
      hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.72',
      projects: { '/work/a': { hasTrustDialogAccepted: true } },
    });
    expect(JSON.stringify(got)).not.toContain('do-not-copy');
    expect(fs.statSync(path.join(account, '.claude.json')).mode & 0o777).toBe(0o600);
  });

  test('what the account folder already says is kept', () => {
    write(primary, { hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.72', projects: { '/work/a': { hasTrustDialogAccepted: true } } });
    write(path.join(account, '.claude.json'), { hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.331', projects: { '/work/a': { hasTrustDialogAccepted: false, lastCost: 1 }, '/work/z': { lastCost: 2 } } });
    seedAccountClaudeState(account, primary);
    expect(read(path.join(account, '.claude.json'))).toEqual({
      hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.331',
      projects: { '/work/a': { hasTrustDialogAccepted: true, lastCost: 1 }, '/work/z': { lastCost: 2 } },
    });
  });

  test('a computer that has not done the first run gives nothing; the account file is not touched', () => {
    write(primary, { projects: { '/work/a': { hasTrustDialogAccepted: true } } });
    write(path.join(account, '.claude.json'), { userID: 'team-user' });
    expect(seedAccountClaudeState(account, primary)).toBe(false);
    expect(read(path.join(account, '.claude.json'))).toEqual({ userID: 'team-user' });
  });

  test('no state file of the computer, no account file, or a file that is not JSON: nothing is written and nothing throws', () => {
    expect(seedAccountClaudeState(account, primary)).toBe(false);
    write(primary, { hasCompletedOnboarding: true });
    expect(seedAccountClaudeState(account, primary)).toBe(false); // Claude Code has not made the account file
    fs.writeFileSync(path.join(account, '.claude.json'), '{ not json');
    expect(seedAccountClaudeState(account, primary)).toBe(false);
    expect(fs.readFileSync(path.join(account, '.claude.json'), 'utf8')).toBe('{ not json');
    expect(fs.readdirSync(account)).toEqual(['.claude.json']);
  });

  test('the state file of the computer is in the home folder, or in CLAUDE_CONFIG_DIR when that is set', () => {
    expect(primaryClaudeStateFile({}, '/home/me')).toBe('/home/me/.claude.json');
    expect(primaryClaudeStateFile({ CLAUDE_CONFIG_DIR: '/cfg' }, '/home/me')).toBe('/cfg/.claude.json');
  });
});
