import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentDirFor, assertInHome, isInside, privateRoots, publishToAgent, publishTreeToAgent, runDirFor, scratchDirFor } from '../../src/privsep/paths.js';
import { agentCopyFrom, agentMkdir, agentReadFile, agentRemove, agentRename, agentWriteFile } from '../../src/privsep/agent-fs.js';
import { isLocalPeer, isLoopback } from '../../src/privsep/local-peer.js';
import type { PrivsepConfig } from '../../src/privsep/config.js';

let root: string;
let cfg: PrivsepConfig;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'privsep-paths-')));
  const me = { uid: process.getuid!(), gid: process.getgid!() };
  // The test process is not root, so "the agent" is the test's own user: owner changes are no-ops
  // and the mode and path rules are what is under test.
  cfg = { agentUid: me.uid, agentGid: me.gid, stateDir: path.join(root, 'gate', 'state'), agentRunDir: path.join(root, 'run'), agentHome: path.join(root, 'home'), agentDataDir: path.join(root, 'home', '.dispatch') };
  fs.mkdirSync(cfg.stateDir, { recursive: true });
  fs.mkdirSync(cfg.agentRunDir, { recursive: true });
  fs.mkdirSync(cfg.agentHome, { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('path roots', () => {
  test('without privilege separation every helper returns the old path and touches nothing', () => {
    expect(runDirFor('/data', 'keys', null)).toBe('/data/keys');
    expect(agentDirFor('/data', 'chat', null)).toBe('/data/chat');
    expect(scratchDirFor('/data', 'run', null)).toBe('/data/run');
    expect(assertInHome('/anywhere', null)).toBe('/anywhere');
    expect(privateRoots(null)).toEqual([]);
    expect(fs.existsSync('/data')).toBe(false);
  });

  test('a run folder is for the agent group to read, never to write', () => {
    const dir = runDirFor('/unused', 'keys', cfg);
    expect(dir).toBe(path.join(cfg.agentRunDir, 'keys'));
    expect(fs.statSync(dir).mode & 0o777).toBe(0o750);
    const file = path.join(dir, 'k');
    fs.writeFileSync(file, 'x', { mode: 0o600 });
    publishToAgent(file, cfg);
    expect(fs.statSync(file).mode & 0o777).toBe(0o640);
    const exe = path.join(dir, 'tool');
    fs.writeFileSync(exe, 'x', { mode: 0o755 });
    publishToAgent(exe, cfg);
    expect(fs.statSync(exe).mode & 0o777).toBe(0o750);
  });

  test('a symbolic link is never published', () => {
    const dir = runDirFor('/unused', 'mcp', cfg);
    const link = path.join(dir, 'l');
    fs.symlinkSync(path.join(cfg.stateDir, 'dispatch.db'), link);
    expect(() => publishToAgent(link, cfg)).toThrow(/symbolic link/);
  });

  test('a folder name with a separator is refused', () => {
    expect(() => runDirFor('/d', '../state', cfg)).toThrow(/plain folder name/);
    expect(() => agentDirFor('/d', 'a/b', cfg)).toThrow(/plain folder name/);
  });

  test('agent data lives below the home', () => {
    expect(agentDirFor('/unused', 'chat', cfg)).toBe(path.join(cfg.agentHome, '.dispatch', 'chat'));
    expect(fs.statSync(path.join(cfg.agentHome, '.dispatch', 'chat')).isDirectory()).toBe(true);
  });

  test('a path below the home that really leads into the state root is recognised', () => {
    fs.symlinkSync(cfg.stateDir, path.join(cfg.agentHome, 'innocent'));
    expect(() => assertInHome(path.join(cfg.agentHome, 'innocent', 'settings.json'), cfg)).toThrow(/leaves the home/);
    const target = path.join(cfg.agentHome, 'projects', 'a', 'b');
    expect(assertInHome(target, cfg)).toBe(target); // a missing leaf below the home is fine
  });

  test('a published tree is readable by the agent group all the way down, and a link in it is refused', () => {
    const dir = path.join(runDirFor('/unused', 'hooks', cfg), 'opencode-homes', 't1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'opencode.json'), '{}', { mode: 0o600 });
    publishTreeToAgent(path.dirname(dir), cfg);
    expect(fs.statSync(dir).mode & 0o070).toBe(0o050);
    expect(fs.statSync(path.join(dir, 'opencode.json')).mode & 0o777).toBe(0o640);
    fs.symlinkSync('/etc/passwd', path.join(dir, 'link'));
    expect(() => publishTreeToAgent(path.dirname(dir), cfg)).toThrow(/symbolic link/);
  });

  test('the private roots include the parent of the state root', () => {
    expect(privateRoots(cfg)).toEqual([path.join(root, 'gate'), cfg.stateDir, cfg.agentRunDir]);
    expect(isInside('/a/b', '/a')).toBe(true);
    expect(isInside('/ab', '/a')).toBe(false);
  });
});

describe('local peers', () => {
  const interfaces = () => ({ eth0: [{ address: '10.1.2.3' }, { address: 'fe80::1' }, { address: '2001:db8::5' }] }) as any;
  test('loopback in every spelling', () => {
    for (const a of ['127.0.0.1', '127.9.9.9', '::1', '::ffff:127.0.0.1', '0:0:0:0:0:0:0:1']) expect(isLoopback(a)).toBe(true);
    expect(isLoopback('10.0.0.1')).toBe(false);
  });
  test("the box's own addresses are local; another host is not", () => {
    expect(isLocalPeer('10.1.2.3', { interfaces })).toBe(true);
    expect(isLocalPeer('::ffff:10.1.2.3', { interfaces })).toBe(true);
    expect(isLocalPeer('fe80::1%eth0', { interfaces })).toBe(true);
    expect(isLocalPeer('2001:DB8::5', { interfaces })).toBe(true);
    expect(isLocalPeer('10.1.2.4', { interfaces })).toBe(false);
    expect(isLocalPeer('172.17.0.1', { interfaces })).toBe(false);
  });
  test('no address: treated as local (fail closed)', () => {
    expect(isLocalPeer(undefined, { interfaces })).toBe(true);
    expect(isLocalPeer('', { interfaces })).toBe(true);
  });
});

describe('file changes below the home, made as the agent', () => {
  // `cfg` here is "privilege separation on, the agent is this test's own user": every call goes
  // through the one-command path the daemon uses on a box. `null` is the local path (plain fs).
  for (const mode of ['separated', 'local'] as const) {
    const c = () => (mode === 'separated' ? cfg : null);
    test(`${mode}: write, exclusive write, append, and the mode of a new file`, () => {
      const f = path.join(cfg.agentHome, 'a.txt');
      agentWriteFile(f, 'one\n', {}, c());
      expect(fs.readFileSync(f, 'utf8')).toBe('one\n');
      agentWriteFile(f, 'two\n', {}, c());
      expect(fs.readFileSync(f, 'utf8')).toBe('two\n');
      agentWriteFile(f, 'three\n', { flag: 'a' }, c());
      expect(fs.readFileSync(f, 'utf8')).toBe('two\nthree\n');
      expect(() => agentWriteFile(f, 'x', { flag: 'wx' }, c())).toThrow();
      expect(fs.readFileSync(f, 'utf8')).toBe('two\nthree\n');
      const secret = path.join(cfg.agentHome, 'private.bin');
      agentWriteFile(secret, Buffer.from([0, 1, 2, 255]), { mode: 0o600, flag: 'wx' }, c());
      expect(fs.statSync(secret).mode & 0o777).toBe(0o600);
      expect([...fs.readFileSync(secret)]).toEqual([0, 1, 2, 255]);
    });
    test(`${mode}: folders, copies, renames and removals`, () => {
      const dir = path.join(cfg.agentHome, 'p', 'q r', "it's");
      agentMkdir(dir, c());
      agentMkdir(dir, c()); // again: no error
      expect(fs.statSync(dir).isDirectory()).toBe(true);
      const src = path.join(root, 'upload.tmp');
      fs.writeFileSync(src, 'uploaded');
      agentCopyFrom(src, path.join(dir, 'up load.txt'), c());
      expect(fs.readFileSync(path.join(dir, 'up load.txt'), 'utf8')).toBe('uploaded');
      agentRename(path.join(dir, 'up load.txt'), path.join(dir, '-dash.txt'), c());
      expect(fs.existsSync(path.join(dir, '-dash.txt'))).toBe(true);
      agentRemove(path.join(dir, '-dash.txt'), {}, c());
      expect(fs.existsSync(path.join(dir, '-dash.txt'))).toBe(false);
      expect(() => agentRemove(path.join(cfg.agentHome, 'p'), {}, c())).toThrow(); // a folder needs `recursive`
      agentRemove(path.join(cfg.agentHome, 'p'), { recursive: true }, c());
      expect(fs.existsSync(path.join(cfg.agentHome, 'p'))).toBe(false);
    });
  }

  for (const mode of ['separated', 'local'] as const) {
    const c = () => (mode === 'separated' ? cfg : null);
    test(`${mode}: read a file as the agent: the bytes, the size limit, never a link or a folder`, async () => {
      const f = path.join(cfg.agentHome, 'report.csv');
      fs.writeFileSync(f, Buffer.from([0x61, 0x2c, 0x62, 0x0a, 0x00, 0xff]));
      expect([...(await agentReadFile(f, 100, c()))!]).toEqual([0x61, 0x2c, 0x62, 0x0a, 0x00, 0xff]);
      expect((await agentReadFile(f, 6, c()))!.length).toBe(6); // exactly the limit
      expect(await agentReadFile(f, 5, c())).toBeNull(); // one byte over
      fs.writeFileSync(path.join(cfg.agentHome, 'empty.txt'), '');
      expect((await agentReadFile(path.join(cfg.agentHome, 'empty.txt'), 10, c()))!.length).toBe(0);
      // A link as the last part of the path is not followed, wherever it points.
      fs.writeFileSync(path.join(cfg.stateDir, 'settings.json'), '{"private":true}');
      const link = path.join(cfg.agentHome, 'innocent.json');
      fs.symlinkSync(path.join(cfg.stateDir, 'settings.json'), link);
      expect(await agentReadFile(link, 100, c())).toBeNull();
      expect(await agentReadFile(cfg.agentHome, 100, c())).toBeNull(); // a folder
      expect(await agentReadFile(path.join(cfg.agentHome, 'missing.txt'), 100, c())).toBeNull();
    });
  }

  test('a file with a name that looks like program text is read as a file', async () => {
    const odd = path.join(cfg.agentHome, `x"; process.exit(0); ".txt`);
    fs.writeFileSync(odd, 'plain');
    expect((await agentReadFile(odd, 100, cfg))!.toString()).toBe('plain');
  });

  test('a path is one argument, never program text', () => {
    const marker = 'privsep-injected-marker';
    const before = process.cwd();
    process.chdir(cfg.agentHome);
    try {
      const evil = path.join(cfg.agentHome, `x"; require("fs").writeFileSync("${marker}", ""); "`);
      agentWriteFile(evil, 'data', {}, cfg);
      expect(fs.readFileSync(evil, 'utf8')).toBe('data');
      agentMkdir(path.join(cfg.agentHome, '$(touch ' + marker + ')'), cfg);
      agentMkdir(path.join(cfg.agentHome, '`touch ' + marker + '`'), cfg);
      expect(fs.existsSync(path.join(cfg.agentHome, marker))).toBe(false);
    } finally { process.chdir(before); }
  });

  test('a failure carries a reason', () => {
    expect(() => agentWriteFile(path.join(cfg.agentHome, 'missing-dir', 'f'), 'x', {}, cfg)).toThrow(/ENOENT/);
    try { agentWriteFile(path.join(cfg.agentHome, 'missing-dir', 'f'), 'x', {}, cfg); } catch (e) { expect((e as NodeJS.ErrnoException).code).toBe('ENOENT'); }
    expect(() => agentRename(path.join(cfg.agentHome, 'nope'), path.join(cfg.agentHome, 'b'), cfg)).toThrow();
  });

  test('a copy never follows a link placed where the daemon expects its own file', () => {
    const src = path.join(root, 'upload.tmp');
    fs.symlinkSync(path.join(cfg.stateDir, 'dispatch.db'), src);
    expect(() => agentCopyFrom(src, path.join(cfg.agentHome, 'out'), cfg)).toThrow();
  });
});
