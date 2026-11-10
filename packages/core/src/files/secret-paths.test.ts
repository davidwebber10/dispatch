import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultSecretRoots, holdsSecret, isSecretPath, SECRET_PATH_ERROR, type SecretRoots } from './secret-paths.js';

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

  // v4.5.0 review, I4.
  it('denies the git credential store and the other token files of the home folder', () => {
    for (const p of [
      inHome('.git-credentials'),
      inHome('.config', 'git', 'credentials'),
      inHome('.config', 'gh', 'hosts.yml'),
      inHome('.netrc'),
      inHome('.npmrc'),
      inHome('.aws', 'credentials'),
      inHome('.docker', 'config.json'),
      inHome('.kube', 'config'),
    ]) expect(isSecretPath(p, roots), p).toBe(true);
    expect(isSecretPath(inHome('Sites', 'repo', '.git-credentials'), roots)).toBe(false);
  });

  // v4.5.0 review, I4: on macOS `/System/Volumes/Data/<path>` is a second name of `/<path>`, and realpath keeps it.
  it('the /System/Volumes/Data form of a path is judged as the plain path', () => {
    const alt = (p: string) => `/System/Volumes/Data${p}`;
    expect(isSecretPath(alt(inData('access-token')), roots)).toBe(true);
    expect(isSecretPath(alt(inHome('.ssh', 'id_ed25519')), roots)).toBe(true);
    expect(isSecretPath(alt(inHome('.SSH', 'id_ed25519')).replace('/System/Volumes/Data', '/system/volumes/data'), roots)).toBe(true);
    expect(isSecretPath(alt(inHome('Sites', 'repo', 'a.ts')), roots)).toBe(false);
    // The roots in that form match the plain path too.
    const altRoots = { home: alt(roots.home), dataDir: alt(roots.dataDir) };
    expect(isSecretPath(inData('access-token'), altRoots)).toBe(true);
    expect(isSecretPath(inHome('Sites', 'repo', 'a.ts'), altRoots)).toBe(false);
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

// v4.5.0 review, I4: the text of a path is not the file. A hard link and a second mount path name the same file with
// another text, so the file that is served is compared by its identity (device and inode) too.
describe('holdsSecret (file identity)', () => {
  let elsewhere: string;
  beforeEach(() => {
    elsewhere = path.join(base, 'elsewhere');
    for (const d of [inData('keys'), inData('plugins', 'coach'), inHome('.ssh'), inHome('.config', 'gh'), inHome('Sites', 'repo'), elsewhere]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(inData('access-token'), 'the-owner-token');
    fs.writeFileSync(inData('access-token.123.tmp'), 'the-next-token');
    fs.writeFileSync(inData('keys', 't1.h1'), 'a thread key');
    fs.writeFileSync(inData('plugins', 'coach', 'data.db'), 'sqlite');
    fs.writeFileSync(inData('installer.json'), '{}');
    fs.writeFileSync(inHome('.ssh', 'id_ed25519'), 'PRIVATE KEY');
    fs.writeFileSync(inHome('.git-credentials'), 'https://u:p@host');
    fs.writeFileSync(inHome('.config', 'gh', 'hosts.yml'), 'oauth_token: x');
    fs.writeFileSync(inHome('Sites', 'repo', 'a.ts'), 'code');
  });

  it('a secret path and an ordinary path get the answer of the text rule', async () => {
    expect(await holdsSecret(inData('access-token'), roots)).toBe(true);
    expect(await holdsSecret(inHome('.ssh', 'no-such-key'), roots)).toBe(true);
    expect(await holdsSecret(inHome('Sites', 'repo', 'a.ts'), roots)).toBe(false);
    expect(await holdsSecret(inData('installer.json'), roots)).toBe(false);
    expect(await holdsSecret(path.join(elsewhere, 'missing.txt'), roots)).toBe(false);
  });

  it('a hard link to a secret file is refused, wherever the link is', async () => {
    const links: Array<[string, string]> = [
      [inData('access-token'), 'token.txt'],
      [inData('access-token.123.tmp'), 'token-tmp.txt'],
      [inHome('.git-credentials'), 'creds.txt'],
      [inHome('.config', 'gh', 'hosts.yml'), 'hosts.txt'],
      [inHome('.ssh', 'id_ed25519'), 'key.txt'],
      [inData('keys', 't1.h1'), 'thread-key.txt'],
      [inData('plugins', 'coach', 'data.db'), 'data.txt'],
    ];
    for (const [target, name] of links) {
      const link = path.join(elsewhere, name);
      fs.linkSync(target, link);
      expect(await holdsSecret(link, roots), name).toBe(true);
    }
  });

  it('the identity of the OPEN file decides: a handle on a hard link is refused', async () => {
    const link = path.join(elsewhere, 'token.txt');
    fs.linkSync(inData('access-token'), link);
    const fh = await fs.promises.open(link, 'r');
    try { expect(await holdsSecret(link, roots, fh)).toBe(true); } finally { await fh.close(); }
    const ok = await fs.promises.open(inHome('Sites', 'repo', 'a.ts'), 'r');
    try { expect(await holdsSecret(inHome('Sites', 'repo', 'a.ts'), roots, ok)).toBe(false); } finally { await ok.close(); }
  });

  it('an ordinary file with two names (a pnpm store file) is not refused', async () => {
    fs.linkSync(inHome('Sites', 'repo', 'a.ts'), path.join(elsewhere, 'a-copy.ts'));
    expect(await holdsSecret(path.join(elsewhere, 'a-copy.ts'), roots)).toBe(false);
    expect(await holdsSecret(inHome('Sites', 'repo', 'a.ts'), roots)).toBe(false);
  });

  it('a second path to the home folder is refused by the identity of the folder, when the text does not match', async () => {
    // The roots are written through a link, so no text of a real path starts with them. This stands for a second
    // mount path of the home folder (a bind mount, a firmlink): the same folder under another text.
    fs.symlinkSync(roots.home, path.join(base, 'homelink'));
    const linked: SecretRoots = { home: path.join(base, 'homelink'), dataDir: path.join(base, 'homelink', '.dispatch') };
    expect(isSecretPath(inHome('.ssh', 'id_ed25519'), linked)).toBe(false); // the text rule alone does not see it
    expect(await holdsSecret(inHome('.ssh', 'id_ed25519'), linked)).toBe(true);
    expect(await holdsSecret(inData('access-token'), linked)).toBe(true);
    expect(await holdsSecret(inData('keys', 't1.h1'), linked)).toBe(true);
    expect(await holdsSecret(inData('plugins', 'coach', 'data.db'), linked)).toBe(true);
    expect(await holdsSecret(inHome('Sites', 'repo', 'a.ts'), linked)).toBe(false);
    expect(await holdsSecret(inData('installer.json'), linked)).toBe(false);
  });

  it.runIf(process.platform === 'darwin' && fs.existsSync('/System/Volumes/Data/private'))('the /System/Volumes/Data path of a secret on this disk is refused', async () => {
    const alt = (p: string) => `/System/Volumes/Data${p}`;
    expect(fs.readFileSync(alt(inData('access-token')), 'utf8')).toBe('the-owner-token'); // the second path does reach the file
    expect(fs.realpathSync(alt(inData('access-token')))).toBe(alt(inData('access-token'))); // and realpath keeps it
    expect(await holdsSecret(alt(inData('access-token')), roots)).toBe(true);
    expect(await holdsSecret(alt(inHome('.ssh', 'id_ed25519')), roots)).toBe(true);
    expect(await holdsSecret(alt(inHome('Sites', 'repo', 'a.ts')), roots)).toBe(false);
  });
});
