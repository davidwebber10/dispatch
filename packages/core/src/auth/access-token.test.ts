import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  COOKIE_NAME, cookieValue, ensureAccessToken, parseCookies, readAccessToken, rotateAccessToken,
} from './access-token.js';

let dir: string;
let oldUmask: number;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ne-token-'));
  oldUmask = process.umask(0o022);
});
afterEach(() => {
  process.umask(oldUmask);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('access token', () => {
  test('creates a 43 char base64url token with mode 0600 even under umask 022', () => {
    const t = ensureAccessToken(dir);
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(fs.statSync(path.join(dir, 'access-token')).mode & 0o777).toBe(0o600);
  });
  test('returns the same token on the second call; rotate changes it', () => {
    const a = ensureAccessToken(dir);
    expect(ensureAccessToken(dir)).toBe(a);
    const b = rotateAccessToken(dir);
    expect(b).not.toBe(a);
    expect(readAccessToken(dir)).toBe(b);
    expect(fs.statSync(path.join(dir, 'access-token')).mode & 0o777).toBe(0o600);
  });
  test('readAccessToken is null when no file exists', () => {
    expect(readAccessToken(dir)).toBeNull();
  });
});

describe('cookie', () => {
  test('value is deterministic, per token, and not the token', () => {
    expect(cookieValue('a')).toBe(cookieValue('a'));
    expect(cookieValue('a')).not.toBe(cookieValue('b'));
    expect(cookieValue('abcdefgh')).not.toContain('abcdefgh');
  });
  test('parseCookies', () => {
    expect(parseCookies(`x=1; ${COOKIE_NAME}=abc`)[COOKIE_NAME]).toBe('abc');
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies('garbage')).toEqual({});
  });
});
