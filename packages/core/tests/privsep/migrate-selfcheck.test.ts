import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MIGRATION_MARKER, classifyEntry, migrateLegacyHome } from '../../src/privsep/migrate.js';
import { execFileSync } from 'node:child_process';
import { REQUIRED_CHECKS, SELF_CHECK_SCRIPT, judgeSelfCheck, runSelfCheck } from '../../src/privsep/selfcheck.js';

let root: string; let legacy: string; let state: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'privsep-migrate-'));
  legacy = path.join(root, 'home', '.dispatch');
  state = path.join(root, 'state');
  fs.mkdirSync(legacy, { recursive: true });
  fs.mkdirSync(state, { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function oldBox(): void {
  fs.writeFileSync(path.join(legacy, 'dispatch.db'), 'DB-CONTENT');
  fs.writeFileSync(path.join(legacy, 'dispatch.db-wal'), 'WAL');
  fs.writeFileSync(path.join(legacy, 'access-token'), 'owner-token');
  fs.writeFileSync(path.join(legacy, 'accounts.json'), '{}');
  fs.writeFileSync(path.join(legacy, 'thread-abc.mcp.json'), '{}');
  fs.mkdirSync(path.join(legacy, 'keys')); fs.writeFileSync(path.join(legacy, 'keys', 't1.abc'), 'dtk_x');
  fs.mkdirSync(path.join(legacy, 'plugins', 'p1'), { recursive: true }); fs.writeFileSync(path.join(legacy, 'plugins', 'p1', 'plugin.json'), '{}');
  fs.mkdirSync(path.join(legacy, 'claude-accounts', 'a1'), { recursive: true }); fs.writeFileSync(path.join(legacy, 'claude-accounts', 'a1', '.credentials.json'), 'cred');
  fs.mkdirSync(path.join(legacy, 'chat')); fs.writeFileSync(path.join(legacy, 'chat', 'note'), 'n');
}

describe('entries of the old data directory', () => {
  test('harness folders stay, generated files go, everything else is state (a new name is private)', () => {
    for (const n of ['claude-accounts', 'codex-accounts', 'chat', 'tools', 'grok-homes']) expect(classifyEntry(n)).toBe('agent');
    for (const n of ['keys', 'prompts', 'bin', 'hooks', 'access-token', 'thread-abc.mcp.json']) expect(classifyEntry(n)).toBe('regenerated');
    for (const n of ['dispatch.db', 'accounts.json', 'plugins', 'mcp.json', 'something-new']) expect(classifyEntry(n)).toBe('private');
  });
});

describe('moving an older box', () => {
  test('imports the private entries, keeps the harness folders, removes the rest from the home', () => {
    oldBox();
    const r = migrateLegacyHome({ legacyDir: legacy, stateDir: state, allowImport: true });
    expect(r.imported.sort()).toEqual(['accounts.json', 'dispatch.db', 'dispatch.db-wal', 'plugins']);
    expect(fs.readFileSync(path.join(state, 'dispatch.db'), 'utf8')).toBe('DB-CONTENT');
    expect(fs.readFileSync(path.join(state, 'plugins', 'p1', 'plugin.json'), 'utf8')).toBe('{}');
    expect(fs.existsSync(path.join(state, MIGRATION_MARKER))).toBe(true);
    expect(fs.existsSync(path.join(state, 'access-token'))).toBe(false); // the old owner token is not carried over
    expect(fs.readdirSync(legacy).sort()).toEqual(['chat', 'claude-accounts']);
    expect(fs.readFileSync(path.join(legacy, 'claude-accounts', 'a1', '.credentials.json'), 'utf8')).toBe('cred');
    expect(fs.statSync(path.join(state, 'dispatch.db')).mode & 0o077).toBe(0);
  });

  test('a second start does nothing more', () => {
    oldBox();
    migrateLegacyHome({ legacyDir: legacy, stateDir: state, allowImport: true });
    fs.writeFileSync(path.join(state, 'dispatch.db'), 'NEWER');
    const r = migrateLegacyHome({ legacyDir: legacy, stateDir: state, allowImport: true });
    expect(r.skipped).toBe('already-migrated');
    expect(r.imported).toEqual([]);
    expect(fs.readFileSync(path.join(state, 'dispatch.db'), 'utf8')).toBe('NEWER');
  });

  test('a database planted in the home after the move is never imported, and is removed', () => {
    oldBox();
    migrateLegacyHome({ legacyDir: legacy, stateDir: state, allowImport: true });
    fs.writeFileSync(path.join(legacy, 'dispatch.db'), 'PLANTED');
    const r = migrateLegacyHome({ legacyDir: legacy, stateDir: state, allowImport: true });
    expect(r.imported).toEqual([]);
    expect(fs.readFileSync(path.join(state, 'dispatch.db'), 'utf8')).toBe('DB-CONTENT');
    expect(fs.existsSync(path.join(legacy, 'dispatch.db'))).toBe(false);
  });

  test('interrupted during the copy: the next start repeats the whole import', () => {
    oldBox();
    fs.mkdirSync(path.join(state, '.incoming'));
    fs.writeFileSync(path.join(state, '.incoming', 'dispatch.db'), 'HALF');
    const r = migrateLegacyHome({ legacyDir: legacy, stateDir: state, allowImport: true });
    expect(r.imported).toContain('dispatch.db');
    expect(fs.readFileSync(path.join(state, 'dispatch.db'), 'utf8')).toBe('DB-CONTENT');
    expect(fs.existsSync(path.join(state, '.incoming'))).toBe(false);
  });

  test('interrupted during the renames (the database is last): repeated in full', () => {
    oldBox();
    fs.writeFileSync(path.join(state, 'accounts.json'), 'PARTIAL'); // renamed in, then the box stopped
    const r = migrateLegacyHome({ legacyDir: legacy, stateDir: state, allowImport: true });
    expect(r.imported).toContain('dispatch.db');
    expect(fs.readFileSync(path.join(state, 'accounts.json'), 'utf8')).toBe('{}');
  });

  test('interrupted after the import, before the clean-up: the clean-up runs on the next start', () => {
    oldBox();
    fs.writeFileSync(path.join(state, 'dispatch.db'), 'DB-CONTENT'); // the import finished
    const r = migrateLegacyHome({ legacyDir: legacy, stateDir: state, allowImport: true });
    expect(r.skipped).toBe('state-not-empty');
    expect(fs.existsSync(path.join(legacy, 'dispatch.db'))).toBe(false);
    expect(fs.existsSync(path.join(state, MIGRATION_MARKER))).toBe(true);
  });

  test('import not allowed: nothing is copied and NOTHING is deleted', () => {
    oldBox();
    const before = fs.readdirSync(legacy).sort();
    const r = migrateLegacyHome({ legacyDir: legacy, stateDir: state, allowImport: false });
    expect(r.skipped).toBe('not-allowed');
    expect(fs.readdirSync(legacy).sort()).toEqual(before);
    expect(fs.existsSync(path.join(state, MIGRATION_MARKER))).toBe(false);
  });

  test('a new box: only the marker', () => {
    const r = migrateLegacyHome({ legacyDir: legacy, stateDir: state, allowImport: false });
    expect(r.skipped).toBe('no-legacy-state');
    expect(fs.readdirSync(state)).toEqual([MIGRATION_MARKER]);
  });

  test('links in the old directory are not imported, at any depth, and never followed', () => {
    oldBox();
    const secret = path.join(root, 'outside-secret'); fs.writeFileSync(secret, 'SECRET');
    fs.symlinkSync(secret, path.join(legacy, 'icons'));
    fs.symlinkSync(state, path.join(legacy, 'plugins', 'p1', 'loop'));
    migrateLegacyHome({ legacyDir: legacy, stateDir: state, allowImport: true });
    expect(fs.existsSync(path.join(state, 'icons'))).toBe(false);
    expect(fs.existsSync(path.join(state, 'plugins', 'p1', 'loop'))).toBe(false);
    expect(fs.readFileSync(path.join(state, 'plugins', 'p1', 'plugin.json'), 'utf8')).toBe('{}');
    expect(fs.readFileSync(secret, 'utf8')).toBe('SECRET');
  });

  test('the old directory replaced by a link is not read', () => {
    fs.rmSync(legacy, { recursive: true });
    const elsewhere = path.join(root, 'elsewhere'); fs.mkdirSync(elsewhere); fs.writeFileSync(path.join(elsewhere, 'dispatch.db'), 'X');
    fs.symlinkSync(elsewhere, legacy);
    const r = migrateLegacyHome({ legacyDir: legacy, stateDir: state, allowImport: true });
    expect(r.imported).toEqual([]);
    expect(fs.existsSync(path.join(elsewhere, 'dispatch.db'))).toBe(true);
  });
});

describe('the start-up self-check', () => {
  const allPass = REQUIRED_CHECKS.map((n) => `PASS ${n}`).join('\n');
  test('passes only when every required check passed', () => {
    expect(judgeSelfCheck(allPass)).toMatchObject({ ok: true, failures: [] });
  });
  test('one FAIL line fails it', () => {
    const r = judgeSelfCheck(allPass.replace('PASS daemon-environ', 'FAIL daemon-environ readable'));
    expect(r.ok).toBe(false);
    expect(r.failures).toEqual(['daemon-environ: readable']);
  });
  test('a script that stopped early proves nothing', () => {
    const r = judgeSelfCheck('PASS uid\nPASS no-new-privs');
    expect(r.ok).toBe(false);
    expect(r.failures).toContain('state-root: not reported');
  });
  test('a check that both passed and failed counts as failed', () => {
    expect(judgeSelfCheck(`${allPass}\nFAIL proc-environ-token /proc/7/environ`).ok).toBe(false);
  });
  // The real script, with a stand-in `unshare` first on the PATH: only the `userns` line is read.
  const usernsLine = (unshareExit: number): string => {
    const bin = path.join(root, 'bin'); fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'unshare'), `#!/bin/sh\nexit ${unshareExit}\n`, { mode: 0o755 });
    const out = execFileSync('/bin/sh', ['-c', SELF_CHECK_SCRIPT, 'selfcheck', '1', state, root, root, String(process.getuid?.() ?? 0)],
      { env: { PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').find((l) => / userns( |$)/.test(l)) ?? '';
  };
  test('a user namespace the agent can make fails the check (no privsep-v1)', () => {
    expect(usernsLine(0)).toBe('FAIL userns a user namespace can be created');
    expect(judgeSelfCheck(`${allPass.replace('PASS userns', '')}\nFAIL userns a user namespace can be created`)).toMatchObject({ ok: false, failures: ['userns: a user namespace can be created'] });
  });
  test('a refused user namespace passes it', () => {
    expect(usernsLine(1)).toBe('PASS userns');
  });
  test('the script that cannot run is a failure, not a pass', async () => {
    const cfg = { agentUid: 1000, agentGid: 1000, stateDir: '/s/state', agentRunDir: '/r', agentHome: '/h', agentDataDir: '/h/.dispatch' };
    const r = await runSelfCheck(cfg, { run: async () => { throw new Error('spawn failed'); } });
    expect(r.ok).toBe(false);
    const seen: string[][] = [];
    await runSelfCheck(cfg, { pid: 42, run: async (_s, args) => { seen.push(args); return allPass; } });
    expect(seen[0]).toEqual(['42', '/s/state', '/s', '/r', '1000']);
  });
});
