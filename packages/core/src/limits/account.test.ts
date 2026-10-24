import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { claudeAccountId, codexAccountId, tokenAccountId, codexLoginChangedAt } from './account.js';

describe('account ids', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-'));
  it('reads the Claude account uuid and follows a switch', () => {
    const f = path.join(home, '.claude.json');
    fs.writeFileSync(f, JSON.stringify({ oauthAccount: { accountUuid: 'u-1' } }));
    expect(claudeAccountId({}, home)).toBe('u-1');
    fs.writeFileSync(f, JSON.stringify({ oauthAccount: { accountUuid: 'u-2', pad: 'x' } }));
    expect(claudeAccountId({}, home)).toBe('u-2');
  });
  it('honors CLAUDE_CONFIG_DIR and CODEX_HOME, and returns "" when unreadable', () => {
    const cfg = path.join(home, 'cfg'); fs.mkdirSync(cfg);
    fs.writeFileSync(path.join(cfg, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'a@b.c' } }));
    expect(claudeAccountId({ CLAUDE_CONFIG_DIR: cfg }, home)).toBe('a@b.c');
    fs.mkdirSync(path.join(home, 'cx')); fs.writeFileSync(path.join(home, 'cx', 'auth.json'), JSON.stringify({ tokens: { account_id: 'cx-1' } }));
    expect(codexAccountId({ CODEX_HOME: path.join(home, 'cx') }, home)).toBe('cx-1');
    expect(codexAccountId({}, path.join(home, 'none'))).toBe('');
  });
  it('a headless token is the account (hashed, never raw), and a new token is a new account', () => {
    const a = tokenAccountId('secret-token-1');
    expect(a).toMatch(/^token:[0-9a-f]{16}$/);
    expect(a).not.toContain('secret');
    expect(tokenAccountId('secret-token-2')).not.toBe(a);
    expect(tokenAccountId(null)).toBe('');
  });
  it('reports when the Codex login file last changed, 0 when it is missing', () => {
    fs.mkdirSync(path.join(home, 'cx2'), { recursive: true }); fs.writeFileSync(path.join(home, 'cx2', 'auth.json'), '{}');
    expect(codexLoginChangedAt({ CODEX_HOME: path.join(home, 'cx2') }, home)).toBeGreaterThan(0);
    expect(codexLoginChangedAt({}, path.join(home, 'none'))).toBe(0);
  });
});
