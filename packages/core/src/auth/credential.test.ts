import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveCredential, keyAllowedFor } from './credential.js';

const B = (c: string) => c.repeat(43).slice(0, 43);
const DTK = 'dtk_' + B('a');
const DCK = 'dck_' + B('b');
const DSK = 'dsk_' + B('c');
const tok = () => 'owner-token';
const boom = () => { throw new Error('owner token must not be read'); };

const r = (env: NodeJS.ProcessEnv, purpose: 'cli' | 'mcp' | 'shim', readOwnerToken: () => string | null = tok) =>
  resolveCredential({ env, purpose, readOwnerToken });

describe('resolveCredential', () => {
  it('rule 1: a shell key', () => {
    const env = { DISPATCH_AUTH: DSK };
    expect(r(env, 'shim')).toEqual({ mode: 'thread', header: `Bearer ${DSK}` });
    expect(r(env, 'cli')).toEqual({ mode: 'owner', header: 'Bearer owner-token' });
    expect(r(env, 'mcp').mode).toBe('refuse');
  });
  it('rule 2: a thread or chat key', () => {
    for (const k of [DTK, DCK]) {
      for (const p of ['cli', 'mcp', 'shim'] as const) {
        expect(r({ DISPATCH_AUTH: k }, p, boom)).toEqual({ mode: 'thread', header: `Bearer ${k}` });
      }
    }
  });
  it('rule 3: a key file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-'));
    const sandbox = path.join(dir, 'sub');
    fs.mkdirSync(sandbox);
    const f = path.join(sandbox, 'k');
    fs.writeFileSync(f, DTK + '\n');
    expect(r({ DISPATCH_AUTH_FILE: f }, 'cli', boom)).toEqual({ mode: 'thread', header: `Bearer ${DTK}` });
    fs.writeFileSync(f, 'junk');
    expect(r({ DISPATCH_AUTH_FILE: f }, 'cli', boom).mode).toBe('refuse');
    const missing = r({ DISPATCH_AUTH_FILE: path.join(sandbox, 'nope'), DISPATCH_TERMINAL_ID: 't' }, 'cli', boom);
    expect(missing).toMatchObject({ mode: 'refuse' });
    expect((missing as { reason: string }).reason).toContain('no Dispatch key');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it('rule 4: a marker and no usable key', () => {
    for (const marker of ['DISPATCH_TERMINAL_ID', 'DISPATCH_TERMINAL']) {
      const env = { [marker]: 't1' };
      const c = r(env, 'cli', boom);
      expect(c.mode).toBe('refuse');
      expect((c as { reason: string }).reason).toContain('This thread has no Dispatch key');
      expect(r(env, 'mcp', boom)).toEqual({ mode: 'none' });
      expect(r(env, 'shim', boom)).toEqual({ mode: 'none' });
    }
  });
  it('rule 4: a malformed key with a marker refuses for the cli', () => {
    expect(r({ DISPATCH_AUTH: 'dtk_bad', DISPATCH_TERMINAL_ID: 't' }, 'cli', boom).mode).toBe('refuse');
  });
  it('rule 5: no marker', () => {
    expect(r({}, 'cli')).toEqual({ mode: 'owner', header: 'Bearer owner-token' });
    expect(r({}, 'cli', () => null)).toEqual({ mode: 'none' });
    expect(r({}, 'mcp')).toEqual({ mode: 'none' });
    expect(r({}, 'shim')).toEqual({ mode: 'none' });
  });
});

describe('keyAllowedFor', () => {
  const env = { DISPATCH_API: 'http://127.0.0.1:4000/base/' };
  it('is false with no DISPATCH_API', () => {
    expect(keyAllowedFor('http://127.0.0.1:4000/api/x', {})).toBe(false);
  });
  it('is false for another port, host or missing base path', () => {
    expect(keyAllowedFor('http://127.0.0.1:4001/base/api/x', env)).toBe(false);
    expect(keyAllowedFor('http://evil.example/base/api/x', env)).toBe(false);
    expect(keyAllowedFor('http://127.0.0.1:4000/api/x', env)).toBe(false);
    expect(keyAllowedFor('http://127.0.0.1:4000/basement/api', env)).toBe(false);
    expect(keyAllowedFor('http://127.0.0.1:4000@evil.example/base/api', env)).toBe(false);
  });
  it('is true for a path under it', () => {
    expect(keyAllowedFor('http://127.0.0.1:4000/base/api/x', env)).toBe(true);
    expect(keyAllowedFor('http://127.0.0.1:4000/base', env)).toBe(true);
    expect(keyAllowedFor('http://127.0.0.1:4000/api/x', { DISPATCH_API: 'http://127.0.0.1:4000' })).toBe(true);
  });
});
