import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAccessConfig, isLoopbackName, normalizeHostHeader, originHostPort } from './known-hosts.js';

describe('normalizeHostHeader', () => {
  test.each([
    ['Localhost:3456', 'localhost'],
    ['[::1]:3456', '::1'],
    ['127.0.0.2', '127.0.0.2'],
    ['Machine.TS.net.:3456', 'machine.ts.net'],
    ['', null],
    [undefined, null],
  ])('%s -> %s', (input, out) => {
    expect(normalizeHostHeader(input as string | undefined)).toBe(out);
  });
});

describe('isLoopbackName', () => {
  test('loopback names only', () => {
    expect(isLoopbackName('localhost')).toBe(true);
    expect(isLoopbackName('127.9.9.9')).toBe(true);
    expect(isLoopbackName('::1')).toBe(true);
    expect(isLoopbackName('127.0.0.1.evil.com')).toBe(false);
    expect(isLoopbackName('localhost.evil.com')).toBe(false);
  });
});

describe('originHostPort', () => {
  test('parses and defaults ports', () => {
    expect(originHostPort('http://x:3000')).toEqual({ host: 'x', port: '3000' });
    expect(originHostPort('https://x')).toEqual({ host: 'x', port: '443' });
    expect(originHostPort('http://[::1]:3456')).toEqual({ host: '::1', port: '3456' });
  });
  test('null and junk are null', () => {
    expect(originHostPort('null')).toBeNull();
    expect(originHostPort('not a url')).toBeNull();
    expect(originHostPort('file:///x')).toBeNull();
  });
});

describe('access config', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ne-cfg-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('add, list, remove hosts; names are normalized', () => {
    const c = createAccessConfig(dir);
    expect(c.allowedHosts()).toEqual([]);
    c.addHost('Proxy.Example.com:443');
    expect(c.allowedHosts()).toEqual(['proxy.example.com']);
    c.removeHost('proxy.example.com');
    expect(c.allowedHosts()).toEqual([]);
  });
  test('a second instance sees edits by mtime, without restart', () => {
    const a = createAccessConfig(dir);
    const b = createAccessConfig(dir);
    expect(b.allowedHosts()).toEqual([]);
    a.addHost('x.example.com');
    expect(b.allowedHosts()).toEqual(['x.example.com']);
  });
  test('corrupt file gives empty lists', () => {
    fs.writeFileSync(path.join(dir, 'access.json'), '{nope');
    const c = createAccessConfig(dir);
    expect(c.allowedHosts()).toEqual([]);
    expect(c.allowedOrigins()).toEqual([]);
  });
  test('file is written 0600', () => {
    createAccessConfig(dir).addHost('x.example.com');
    expect(fs.statSync(path.join(dir, 'access.json')).mode & 0o777).toBe(0o600);
  });
});

// W1-C: the optional Cloudflare Access check.
describe('createAccessConfig: cloudflareAccess', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'access-cf-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = () => JSON.parse(fs.readFileSync(path.join(dir, 'access.json'), 'utf8'));
  const AUD = 'a'.repeat(64);

  test('unset: null, with no file and with a file that has hosts only', () => {
    const c = createAccessConfig(dir);
    expect(c.cloudflareAccess()).toBeNull();
    c.addHost('proxy.example.com');
    expect(c.cloudflareAccess()).toBeNull();
    expect(file()).toEqual({ allowedHosts: ['proxy.example.com'] });
  });

  test('set, read back, and cleared; the hosts and the file mode are kept', () => {
    const c = createAccessConfig(dir);
    c.addHost('proxy.example.com');
    c.setCloudflareAccess({ teamDomain: 'https://Acme.cloudflareaccess.com', aud: AUD });
    expect(c.cloudflareAccess()).toEqual({ teamDomain: 'acme.cloudflareaccess.com', aud: AUD });
    expect(c.allowedHosts()).toEqual(['proxy.example.com']);
    expect(fs.statSync(path.join(dir, 'access.json')).mode & 0o777).toBe(0o600);
    // A second reader (the daemon) sees it with no restart.
    expect(createAccessConfig(dir).cloudflareAccess()).toEqual({ teamDomain: 'acme.cloudflareaccess.com', aud: AUD });
    c.addHost('second.example.com');
    expect(c.cloudflareAccess()).toEqual({ teamDomain: 'acme.cloudflareaccess.com', aud: AUD });
    c.setCloudflareAccess(null);
    expect(c.cloudflareAccess()).toBeNull();
    expect(file()).toEqual({ allowedHosts: ['proxy.example.com', 'second.example.com'] });
  });

  test('refuses values that are not a team domain and an aud tag', () => {
    const c = createAccessConfig(dir);
    expect(() => c.setCloudflareAccess({ teamDomain: 'acme.example.com', aud: AUD })).toThrow(/team domain/i);
    expect(() => c.setCloudflareAccess({ teamDomain: 'acme.cloudflareaccess.com', aud: 'x' })).toThrow(/aud/i);
    expect(c.cloudflareAccess()).toBeNull();
  });

  test('a hand-edited value that is not valid reads as set but empty, so the gate fails closed', () => {
    fs.writeFileSync(path.join(dir, 'access.json'), JSON.stringify({ allowedHosts: ['proxy.example.com'], cloudflareAccess: { teamDomain: 'typo.example.com' } }));
    expect(createAccessConfig(dir).cloudflareAccess()).toEqual({ teamDomain: '', aud: '' });
    fs.writeFileSync(path.join(dir, 'access.json'), JSON.stringify({ cloudflareAccess: null }));
    expect(createAccessConfig(dir).cloudflareAccess()).toBeNull();
  });
});
