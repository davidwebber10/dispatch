import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lockDownDataDir } from './private-dir.js';

let root: string;
let oldUmask: number;
const mode = (p: string) => fs.statSync(p).mode & 0o777;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'ne-priv-')); oldUmask = process.umask(0o022); });
afterEach(() => { process.umask(oldUmask); fs.rmSync(root, { recursive: true, force: true }); });

describe('lockDownDataDir', () => {
  test('creates a missing data directory as 0700 and pre-creates dispatch.db as 0600', () => {
    const d = path.join(root, '.dispatch');
    lockDownDataDir(d);
    expect(mode(d)).toBe(0o700);
    expect(mode(path.join(d, 'dispatch.db'))).toBe(0o600);
  });
  test('tightens an existing 0755 directory and 0644 database files', () => {
    const d = path.join(root, '.dispatch');
    fs.mkdirSync(d, { mode: 0o755 });
    fs.chmodSync(d, 0o755);
    for (const f of ['dispatch.db', 'dispatch.db-wal', 'dispatch.db-shm', 'access-token', 'access.json', 'dispatch.out.log']) {
      fs.writeFileSync(path.join(d, f), 'x', { mode: 0o644 });
      fs.chmodSync(path.join(d, f), 0o644);
    }
    lockDownDataDir(d);
    expect(mode(d)).toBe(0o700);
    for (const f of ['dispatch.db', 'dispatch.db-wal', 'dispatch.db-shm', 'access-token', 'access.json']) {
      expect(mode(path.join(d, f))).toBe(0o600);
    }
    expect(mode(path.join(d, 'dispatch.out.log'))).toBe(0o644); // inside a 0700 dir; not ours to touch
  });
  test('locks extra dirs (the log directory) and every .log file in them', () => {
    const d = path.join(root, '.dispatch');
    const logs = path.join(root, 'logs');
    fs.mkdirSync(logs, { mode: 0o755 });
    fs.chmodSync(logs, 0o755);
    fs.writeFileSync(path.join(logs, 'dispatch.out.log'), 'x', { mode: 0o644 });
    fs.chmodSync(path.join(logs, 'dispatch.out.log'), 0o644);
    lockDownDataDir(d, [logs]);
    expect(mode(logs)).toBe(0o700);
    expect(mode(path.join(logs, 'dispatch.out.log'))).toBe(0o600);
  });
  test('a failing chmod warns and does not throw; the process umask is unchanged', () => {
    const warnings: string[] = [];
    const d = path.join(root, 'file-not-dir');
    fs.writeFileSync(d, 'x');
    expect(() => lockDownDataDir(d, [], (m) => warnings.push(m))).not.toThrow();
    expect(warnings.length).toBeGreaterThan(0);
    expect(process.umask()).toBe(0o022);
  });
  test('does not warn on a path that cannot hold unix modes (/mnt/c style)', () => {
    const warnings: string[] = [];
    lockDownDataDir('/mnt/c/definitely/not/here', [], (m) => warnings.push(m));
    expect(warnings).toEqual([]);
  });
});
