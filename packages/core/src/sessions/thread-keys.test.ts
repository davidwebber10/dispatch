import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KeyRegistry } from '../auth/principals.js';
import { ThreadKeys } from './thread-keys.js';

let sandbox: string;
let keyDir: string;
let reg: KeyRegistry;
let tk: ThreadKeys;

beforeEach(() => {
  vi.useFakeTimers();
  // Nested sandbox: every write and delete of these tests stays below `root`.
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-thread-keys-'));
  keyDir = path.join(sandbox, 'root', 'keys');
  fs.mkdirSync(path.join(sandbox, 'root'), { recursive: true });
  reg = new KeyRegistry();
  tk = new ThreadKeys(reg, { keyDir });
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const live = (key: string) => reg.resolve(key) !== null;

describe('PTY keys', () => {
  it('mints a thread key and a shell key', () => {
    const a = tk.mintForSpawn('t1', 'thread');
    const b = tk.mintForSpawn('t2', 'shell');
    expect(reg.resolve(a.key)?.kind).toBe('thread');
    expect(reg.resolve(b.key)?.kind).toBe('shell');
  });

  it('a late exit of the old pid keeps the new key', () => {
    const a = tk.mintForSpawn('t1', 'thread');
    tk.bindPty('t1', 100, a.handle);
    const b = tk.mintForSpawn('t1', 'thread'); // relaunch
    tk.bindPty('t1', 200, b.handle);
    tk.onPtyExit('t1', 100);
    expect(live(a.key)).toBe(false);
    expect(live(b.key)).toBe(true);
    tk.onPtyExit('t1', 200);
    expect(live(b.key)).toBe(false);
  });

  it('an exit with an unknown pid revokes nothing', () => {
    const a = tk.mintForSpawn('t1', 'thread');
    tk.bindPty('t1', 100, a.handle);
    tk.onPtyExit('t1', 999);
    tk.onPtyExit('other', 100);
    expect(live(a.key)).toBe(true);
  });
});

describe('structured keys', () => {
  it('an exit revokes the bound handle and unbinds', () => {
    const a = tk.mintForSpawn('t1', 'thread');
    tk.bindStructured('t1', a.handle);
    tk.onStructuredExit('t1');
    expect(live(a.key)).toBe(false);
    tk.onStructuredExit('t1'); // idempotent
  });

  it('an exit during spawn() (before the new bind) revokes only the old handle', () => {
    const old = tk.mintForSpawn('t1', 'thread');
    tk.bindStructured('t1', old.handle);
    const fresh = tk.mintForSpawn('t1', 'thread'); // minted before manager.spawn
    tk.onStructuredExit('t1'); // the drain kill inside spawn()
    tk.bindStructured('t1', fresh.handle);
    expect(live(old.key)).toBe(false);
    expect(live(fresh.key)).toBe(true);
    tk.onStructuredExit('t1');
    expect(live(fresh.key)).toBe(false);
  });
});

describe('spawnFailed and revokeLive', () => {
  it('spawnFailed revokes the minted key', () => {
    const a = tk.mintForSpawn('t1', 'thread');
    tk.spawnFailed(a.handle);
    expect(live(a.key)).toBe(false);
  });

  it('spawnFailed leaves a bound (running) key alone', () => {
    const a = tk.mintForSpawn('t1', 'thread');
    tk.bindPty('t1', 5, a.handle);
    tk.spawnFailed(a.handle);
    expect(live(a.key)).toBe(true);
  });

  it('revokeLive revokes only the current key of that terminal', () => {
    const a = tk.mintForSpawn('t1', 'thread');
    const b = tk.mintForSpawn('t2', 'thread');
    tk.bindPty('t1', 1, a.handle);
    tk.revokeLive('t1');
    expect(live(a.key)).toBe(false);
    expect(live(b.key)).toBe(true);
  });

  it('revokeAll revokes every tracked key', () => {
    const a = tk.mintForSpawn('t1', 'thread');
    tk.bindPty('t1', 1, a.handle);
    const c = tk.codexKey('t3');
    tk.revokeAll();
    expect(live(a.key)).toBe(false);
    expect(live(c.key)).toBe(false);
  });
});

describe('Codex Pretty sticky key', () => {
  it('a respawn returns the same key, still live 30 s and 10 minutes later', () => {
    const a = tk.codexKey('c1');
    tk.bindStructured('c1', a.handle);
    tk.onStructuredExit('c1'); // exit does not revoke
    vi.advanceTimersByTime(30_000);
    const b = tk.codexKey('c1');
    expect(b.key).toBe(a.key);
    expect(b.handle).toBe(a.handle);
    vi.advanceTimersByTime(600_000);
    expect(live(a.key)).toBe(true);
  });

  it('owner stop then revive returns the same key', () => {
    const a = tk.codexKey('c1');
    tk.bindStructured('c1', a.handle);
    tk.revokeLive('c1');
    tk.onStructuredExit('c1');
    expect(tk.codexKey('c1').key).toBe(a.key);
    expect(live(a.key)).toBe(true);
  });

  it('a failed spawn leaves the sticky key for the retry', () => {
    const a = tk.codexKey('c1');
    tk.spawnFailed(a.handle);
    expect(tk.codexKey('c1').key).toBe(a.key);
  });

  it('archive or delete (revokeSticky) revokes it', () => {
    const a = tk.codexKey('c1');
    tk.revokeSticky('c1');
    expect(live(a.key)).toBe(false);
    expect(tk.codexKey('c1').key).not.toBe(a.key);
  });

  it('a switch to the CLI view revokes it and mints a CLI key', () => {
    const a = tk.codexKey('c1');
    const cli = tk.mintForSpawn('c1', 'thread');
    expect(live(a.key)).toBe(false);
    expect(live(cli.key)).toBe(true);
    // and the sticky entry is gone: a later Pretty spawn mints anew
    const again = tk.codexKey('c1');
    expect(again.key).not.toBe(a.key);
    expect(live(cli.key)).toBe(false); // the registry keeps one live key per terminal
  });

  it('with codexSticky off, codexKey is a normal mint', () => {
    const t2 = new ThreadKeys(reg, { keyDir, codexSticky: false });
    const a = t2.codexKey('c1');
    const b = t2.codexKey('c1');
    expect(b.key).not.toBe(a.key);
    expect(live(a.key)).toBe(false);
  });
});

describe('key files', () => {
  it('writes a per-handle file with mode 0600, never rewritten, deleted at revoke', () => {
    const a = tk.mintForSpawn('t1', 'thread');
    const p = tk.writeKeyFile('t1', a.key, a.handle);
    expect(path.dirname(p)).toBe(keyDir);
    expect(path.basename(p)).toBe(`t1.${a.handle.slice(0, 12)}`);
    expect(fs.readFileSync(p, 'utf8').trim()).toBe(a.key);
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
    expect(() => tk.writeKeyFile('t1', a.key, a.handle)).toThrow(); // never rewritten
    tk.revokeLive('t1');
    expect(fs.existsSync(p)).toBe(false);
  });

  it('an old process that rereads its path after a respawn does not get the new key', () => {
    const a = tk.mintForSpawn('t1', 'thread');
    const oldPath = tk.writeKeyFile('t1', a.key, a.handle);
    const b = tk.mintForSpawn('t1', 'thread');
    const newPath = tk.writeKeyFile('t1', b.key, b.handle);
    expect(newPath).not.toBe(oldPath);
    expect(fs.existsSync(oldPath)).toBe(false);
    expect(fs.readFileSync(newPath, 'utf8')).toContain(b.key);
  });

  it('the sticky revoke and spawnFailed delete the file', () => {
    const a = tk.codexKey('c1');
    const p = tk.writeKeyFile('c1', a.key, a.handle);
    tk.revokeSticky('c1');
    expect(fs.existsSync(p)).toBe(false);
    const b = tk.mintForSpawn('t2', 'thread');
    const q = tk.writeKeyFile('t2', b.key, b.handle);
    tk.spawnFailed(b.handle);
    expect(fs.existsSync(q)).toBe(false);
  });

  it('does not follow a symlink at the key-file path, and never deletes through one', () => {
    const canaryDir = path.join(sandbox, 'canary');
    fs.mkdirSync(canaryDir);
    const canary = path.join(canaryDir, 'victim');
    fs.writeFileSync(canary, 'keep me');
    const a = tk.mintForSpawn('t1', 'thread');
    const p = tk.writeKeyFile('t1', a.key, a.handle);
    // 1. a symlink planted before the write: refused
    const b = tk.mintForSpawn('t1', 'thread');
    const bPath = path.join(keyDir, `t1.${b.handle.slice(0, 12)}`);
    fs.symlinkSync(canary, bPath);
    expect(() => tk.writeKeyFile('t1', b.key, b.handle)).toThrow();
    expect(fs.readFileSync(canary, 'utf8')).toBe('keep me');
    // 2. a symlink swapped in before the revoke: not unlinked, target survives
    fs.rmSync(bPath);
    const c = tk.mintForSpawn('t1', 'thread');
    const cPath = tk.writeKeyFile('t1', c.key, c.handle);
    fs.rmSync(cPath);
    fs.symlinkSync(canary, cPath);
    tk.revokeLive('t1');
    expect(fs.readFileSync(canary, 'utf8')).toBe('keep me');
    expect(fs.lstatSync(cPath).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(p)).toBe(false);
  });

  it('refuses a terminal id that is not a plain name', () => {
    const a = tk.mintForSpawn('t1', 'thread');
    expect(() => tk.writeKeyFile('../x', a.key, a.handle)).toThrow();
  });

  it('throws when no key directory is set', () => {
    const t2 = new ThreadKeys(reg);
    const a = t2.mintForSpawn('t1', 'thread');
    expect(() => t2.writeKeyFile('t1', a.key, a.handle)).toThrow();
  });
});

describe('revokeAllLive', () => {
  it('revokes tracked non-sticky keys and keeps the sticky Codex Pretty key', () => {
    const a = tk.mintForSpawn('t1', 'thread');
    tk.bindPty('t1', 1, a.handle);
    const c = tk.codexKey('c1');
    tk.bindStructured('c1', c.handle);
    tk.revokeAllLive();
    expect(live(a.key)).toBe(false);
    expect(live(c.key)).toBe(true);
  });
});
