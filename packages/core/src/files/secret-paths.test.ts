import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultSecretRoots, isSecretPath, SECRET_PATH_ERROR, type SecretRoots } from './secret-paths.js';

let base: string;
let roots: SecretRoots;
const inData = (...p: string[]) => path.join(roots.dataDir, ...p);
const inHome = (...p: string[]) => path.join(roots.home, ...p);

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-secret-paths-')));
  roots = { home: path.join(base, 'home'), dataDir: path.join(base, 'home', '.dispatch') };
});
afterEach(() => { fs.rmSync(base, { recursive: true, force: true }); });

describe('isSecretPath', () => {
  it('denies the access token, the keys folder and the database under the data dir', () => {
    for (const p of [
      inData('access-token'),
      inData('keys'),
      inData('keys', 'abc.h1'),
      inData('dispatch.db'),
      inData('dispatch.db-wal'),
      inData('dispatch.db-shm'),
      inData('plugins', 'coach', 'data.db'),
      inData('accounts.json'),
      inData('doppler.json'),
      inData('claude-oauth-token'),
      inData('push.json'),
      inData('codex-accounts', 'acc1', 'auth.json'),
    ]) expect(isSecretPath(p, roots), p).toBe(true);
  });

  it('denies the temp copy that an atomic write of a secret file leaves beside it', () => {
    expect(isSecretPath(inData('access-token.tmp'), roots)).toBe(true);
    expect(isSecretPath(inData('accounts.json.123.tmp'), roots)).toBe(true);
  });

  it('denies ~/.ssh, ~/.aws and the CLI credential files', () => {
    for (const p of [
      inHome('.ssh'),
      inHome('.ssh', 'id_ed25519'),
      inHome('.ssh', 'config'),
      inHome('.aws', 'credentials'),
      inHome('.gnupg', 'private-keys-v1.d', 'k.key'),
      inHome('.config', 'gcloud', 'application_default_credentials.json'),
      inHome('.cloudflared', 'tunnel.json'),
      inHome('.kube', 'config'),
      inHome('.docker', 'config.json'),
      inHome('.netrc'),
      inHome('.npmrc'),
      inHome('.claude', '.credentials.json'),
      inHome('.codex', 'auth.json'),
      inHome('.grok', 'auth.json'),
      inHome('.local', 'share', 'opencode', 'auth.json'),
      inHome('.config', 'gh', 'hosts.yml'),
    ]) expect(isSecretPath(p, roots), p).toBe(true);
  });

  it('allows an ordinary file in the data dir and a file in another repository', () => {
    for (const p of [
      inData('roles', 'reviewer', 'role.md'),
      inData('plugins', 'coach', 'web.js'),
      inData('installer.json'),
      inData('marketplaces.json'),
      inData('keys-notes.md'),
      inData('access-tokens-doc.md'),
      inHome('Sites', 'other-repo', 'src', 'index.ts'),
      inHome('Sites', 'other-repo', '.npmrc'),
      inHome('Sites', 'other-repo', 'auth.json'),
      inHome('.claude', 'settings.json'),
      inHome('.codex', 'config.toml'),
      inHome('.docker', 'daemon.json'),
      inHome('.sshrc'),
      path.join(base, 'elsewhere', 'access-token'),
      roots.dataDir,
      roots.home,
    ]) expect(isSecretPath(p, roots), p).toBe(false);
  });

  it('a change of letter case does not go around the list (a case-insensitive disk)', () => {
    expect(isSecretPath(inData('ACCESS-TOKEN'), roots)).toBe(true);
    expect(isSecretPath(inHome('.SSH', 'id_rsa'), roots)).toBe(true);
    expect(isSecretPath(inData('Dispatch.DB'), roots)).toBe(true);
  });

  it('a path with ".." segments is judged by the place it names', () => {
    expect(isSecretPath(`${roots.home}/Sites/../.ssh/id_rsa`, roots)).toBe(true);
    expect(isSecretPath(`${roots.home}/.ssh/../Sites/a.txt`, roots)).toBe(false);
  });

  it('the refusal text is the one the plan names', () => {
    expect(SECRET_PATH_ERROR).toBe('This path holds credentials. Dispatch does not serve it.');
  });
});

describe('defaultSecretRoots', () => {
  it('gives the real location of the home folder and the data dir, so a linked root still matches', () => {
    fs.mkdirSync(path.join(base, 'home', '.dispatch'), { recursive: true });
    fs.symlinkSync(path.join(base, 'home'), path.join(base, 'homelink'));
    const r = defaultSecretRoots(path.join(base, 'homelink', '.dispatch'), path.join(base, 'homelink'));
    expect(r).toEqual({ home: path.join(base, 'home'), dataDir: path.join(base, 'home', '.dispatch') });
  });

  it('keeps the given path when the folder does not exist yet', () => {
    const r = defaultSecretRoots(path.join(base, 'none', '.dispatch'), path.join(base, 'none'));
    expect(r).toEqual({ home: path.join(base, 'none'), dataDir: path.join(base, 'none', '.dispatch') });
  });
});
