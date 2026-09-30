import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toolStatuses, getToolsSpawnEnv, awarenessNote } from '../../src/tools/status.js';
import { toolPaths, hostOsFamily } from '../../src/tools/paths.js';
import type { AuthCheckOutcome } from '../../src/tools/auth-probe.js';

let root: string;
let base: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-s-'));
  base = path.join(root, 'tools');
  fs.writeFileSync(path.join(root, 'tools.json'), JSON.stringify({ tools: [
    { name: 'gh', description: 'GitHub CLI', kind: 'binary', bins: ['gh'], authEnv: ['GH_TOKEN'], envAlias: { GH_TOKEN: 'GITHUB_TOKEN' }, binary: { 'darwin-arm64': { url: 'https://x/gh', archive: 'none' }, 'darwin-x64': { url: 'https://x/gh', archive: 'none' } } },
  ] }));
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

it('reports installed + authed status', () => {
  // not installed yet
  let st = toolStatuses({ base, env: {} }).find((s) => s.name === 'gh')!;
  expect(st.installed).toBe(false);
  expect(st.authed).toBe(false);
  // install a fake bin + provide auth env
  fs.mkdirSync(toolPaths(base).bin, { recursive: true });
  fs.writeFileSync(path.join(toolPaths(base).bin, 'gh'), '#!/bin/sh\n'); fs.chmodSync(path.join(toolPaths(base).bin, 'gh'), 0o755);
  st = toolStatuses({ base, env: { GH_TOKEN: 't' } }).find((s) => s.name === 'gh')!;
  expect(st.installed).toBe(true);
  expect(st.authed).toBe(true);
});

it('getToolsSpawnEnv prepends bin to PATH and resolves envAlias', () => {
  const env = getToolsSpawnEnv({ base, env: { PATH: '/usr/bin', GITHUB_TOKEN: 'ght' } });
  expect(env.PATH.startsWith(toolPaths(base).bin + path.delimiter)).toBe(true);
  expect(env.GH_TOKEN).toBe('ght'); // aliased from GITHUB_TOKEN
});

it('awarenessNote lists installed tools and flags unauthed', () => {
  const note = awarenessNote([
    { name: 'jq', description: 'JSON', kind: 'binary', installed: true, authed: true, authState: 'ok' },
    { name: 'gh', description: 'GitHub CLI', kind: 'binary', installed: true, authed: false, authState: 'needed' },
    { name: 'aws', description: 'AWS', kind: 'script', installed: false, authed: false, authState: 'needed' },
  ]);
  expect(note).toContain('jq');
  expect(note).toContain('gh');
  expect(note).not.toContain('aws'); // not installed
  expect(note.toLowerCase()).toContain('not authenticated'); // gh flagged
});

it('awarenessNote says an unverified sign-in is unverified, not missing', () => {
  const note = awarenessNote([
    { name: 'aws', description: 'AWS CLI v2', kind: 'script', installed: true, authed: false, authState: 'unknown' },
  ]);
  expect(note).toContain('`aws` — AWS CLI v2 (sign-in not verified)');
  expect(note.toLowerCase()).not.toContain('not authenticated');
});

it('awarenessNote is empty when nothing installed', () => {
  expect(awarenessNote([{ name: 'x', description: 'd', kind: 'binary', installed: false, authed: false, authState: 'needed' }])).toBe('');
});

describe('authState: a completed auth check decides; otherwise the env rule does', () => {
  const stateOf = (name: string, env: Record<string, string>, checks?: Record<string, AuthCheckOutcome>) => {
    const s = toolStatuses({ base, env, checks }).find((t) => t.name === name)!;
    expect(s.authed).toBe(s.authState === 'ok'); // `authed` stays for older clients
    return s.authState;
  };
  beforeEach(() => {
    fs.writeFileSync(path.join(root, 'tools.json'), JSON.stringify({ tools: [
      { name: 'gh', description: 'GitHub CLI', kind: 'binary', bins: ['gh'], authEnv: ['GH_TOKEN'], envAlias: { GH_TOKEN: 'GITHUB_TOKEN' }, authCheck: { args: ['auth', 'status'] } },
      { name: 'dbx', description: 'check only', kind: 'binary', bins: ['dbx'], authCheck: { args: ['me'] } },
      { name: 'legacy', description: 'env only', kind: 'binary', bins: ['legacy'], authEnv: ['LEGACY_TOKEN'] },
      { name: 'jq', description: 'no auth', kind: 'binary', bins: ['jq'] },
    ] }));
  });

  it('a passed check is ok even with no auth env (keyring / config-file logins)', () => {
    expect(stateOf('gh', {}, { gh: 'ok' })).toBe('ok');
  });
  it('a failed check is needed, even with the auth env set (the check ran WITH that env)', () => {
    expect(stateOf('gh', {}, { gh: 'failed' })).toBe('needed');
    expect(stateOf('gh', { GH_TOKEN: 'expired' }, { gh: 'failed' })).toBe('needed');
    expect(stateOf('gh', { GITHUB_TOKEN: 'expired' }, { gh: 'failed' })).toBe('needed'); // via envAlias
  });
  it('an unknown check is ok when the auth env is set, else unknown (never "needed")', () => {
    expect(stateOf('gh', { GH_TOKEN: 'fake' }, { gh: 'unknown' })).toBe('ok');
    expect(stateOf('gh', { GITHUB_TOKEN: 'fake' }, { gh: 'unknown' })).toBe('ok');
    expect(stateOf('gh', {}, { gh: 'unknown' })).toBe('unknown');
  });
  it('a check that has not run yet reads the same as an unknown one', () => {
    expect(stateOf('gh', {})).toBe('unknown');
    expect(stateOf('gh', { GH_TOKEN: 'fake' }, {})).toBe('ok');
    expect(stateOf('dbx', {}, {})).toBe('ok'); // no authEnv: the env rule has nothing to require
  });
  it('a check-only entry follows its check result', () => {
    expect(stateOf('dbx', {}, { dbx: 'failed' })).toBe('needed');
    expect(stateOf('dbx', {}, { dbx: 'ok' })).toBe('ok');
  });
  it('an entry with authEnv but no authCheck keeps the old rule: missing env is needed', () => {
    expect(stateOf('legacy', {})).toBe('needed');
    expect(stateOf('legacy', { LEGACY_TOKEN: 'fake' })).toBe('ok');
  });
  it('an entry with neither authEnv nor authCheck stays ok, whatever the cache holds', () => {
    expect(stateOf('jq', {}, { jq: 'failed' })).toBe('ok');
  });

  it('the awareness note follows the check, not the daemon env', () => {
    fs.mkdirSync(toolPaths(base).bin, { recursive: true });
    fs.writeFileSync(path.join(toolPaths(base).bin, 'gh'), '#!/bin/sh\n'); fs.chmodSync(path.join(toolPaths(base).bin, 'gh'), 0o755);
    const signedIn = awarenessNote(toolStatuses({ base, env: {}, checks: { gh: 'ok' } }));
    expect(signedIn).toContain('`gh` — GitHub CLI');
    expect(signedIn.toLowerCase()).not.toContain('not authenticated');
    expect(signedIn).not.toContain('not verified');
    const signedOut = awarenessNote(toolStatuses({ base, env: { GH_TOKEN: 'expired' }, checks: { gh: 'failed' } }));
    expect(signedOut).toContain('`gh` — GitHub CLI (not authenticated');
    const unverified = awarenessNote(toolStatuses({ base, env: {}, checks: { gh: 'unknown' } }));
    expect(unverified).toContain('`gh` — GitHub CLI (sign-in not verified)');
  });
});

it('toolStatuses excludes entries gated to another platform family and includes entries gated to this one', () => {
  const family = hostOsFamily();
  const otherFamily = family === 'darwin' ? 'linux' : 'darwin';
  fs.writeFileSync(path.join(root, 'tools.json'), JSON.stringify({ tools: [
    { name: 'gh', description: 'GitHub CLI', kind: 'binary', bins: ['gh'], binary: { 'darwin-arm64': { url: 'https://x/gh', archive: 'none' }, 'darwin-x64': { url: 'https://x/gh', archive: 'none' } } },
    { name: 'other-only', description: 'gated to the other family', kind: 'binary', bins: ['x'], platforms: [otherFamily], binary: { 'darwin-arm64': { url: 'https://x/x', archive: 'none' }, 'darwin-x64': { url: 'https://x/x', archive: 'none' } } },
    { name: 'this-only', description: 'gated to this family', kind: 'binary', bins: ['y'], platforms: [family], binary: { 'darwin-arm64': { url: 'https://x/y', archive: 'none' }, 'darwin-x64': { url: 'https://x/y', archive: 'none' } } },
  ] }));
  const names = toolStatuses({ base, env: {} }).map((s) => s.name);
  expect(names).not.toContain('other-only');
  expect(names).toContain('this-only');
  expect(names).toContain('gh'); // ungated entries are unaffected
});
