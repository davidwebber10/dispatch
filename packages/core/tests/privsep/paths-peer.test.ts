import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentDirFor, assertInHome, isInside, mkdirForAgent, privateRoots, publishToAgent, runDirFor, scratchDirFor } from '../../src/privsep/paths.js';
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

  test('a path below the home that really leads into the state root is refused', () => {
    fs.symlinkSync(cfg.stateDir, path.join(cfg.agentHome, 'innocent'));
    expect(() => assertInHome(path.join(cfg.agentHome, 'innocent', 'settings.json'), cfg)).toThrow(/leaves the home/);
    expect(() => mkdirForAgent(path.join(cfg.agentHome, 'innocent', 'new'), {}, cfg)).toThrow(/leaves the home/);
    // The data dir itself replaced by a link: nothing is created through it.
    fs.symlinkSync(cfg.stateDir, cfg.agentDataDir);
    expect(() => agentDirFor('/unused', 'chat', cfg)).toThrow(/leaves the home/);
    expect(fs.readdirSync(cfg.stateDir)).toEqual([]);
  });

  test('a missing leaf below the home is fine, and new folders are made one by one', () => {
    const target = path.join(cfg.agentHome, 'projects', 'a', 'b');
    expect(assertInHome(target, cfg)).toBe(target);
    mkdirForAgent(target, {}, cfg);
    expect(fs.statSync(target).isDirectory()).toBe(true);
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
