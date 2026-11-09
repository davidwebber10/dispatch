import { describe, expect, test, vi } from 'vitest';
import { createHmac, createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { createCfAccessVerifier, parseCloudflareAccess, type Jwk, type Jwks } from './cf-access.js';

// Every key here is made in the test. No real token, team or tag.
const TEAM = 'acme.cloudflareaccess.com';
const AUD = 'a'.repeat(64);
const NOW = 1_800_000_000; // seconds

const b64 = (v: unknown) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

function makeKey(kid: string) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' } as Jwk;
  return { kid, privateKey, jwk };
}
const K1 = makeKey('k1');
const K2 = makeKey('k2');

function sign(key: { kid: string; privateKey: KeyObject }, claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
  const head = b64({ alg: 'RS256', kid: key.kid, typ: 'JWT', ...header });
  const body = b64({ aud: [AUD], iss: `https://${TEAM}`, exp: NOW + 300, iat: NOW - 10, nbf: NOW - 10, email: 'owner@example.com', ...claims });
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(key.privateKey).toString('base64url');
  return `${head}.${body}.${sig}`;
}

function verifierWith(keys: () => Jwks | Promise<Jwks>, at = { t: NOW * 1000 }) {
  const fetchJwks = vi.fn(async (_url: string) => keys());
  const log = vi.fn();
  const v = createCfAccessVerifier({ teamDomain: TEAM, aud: AUD, fetchJwks, now: () => at.t, log });
  return { v, fetchJwks, log, at };
}

describe('Cloudflare Access assertion', () => {
  test('accepts a valid token', async () => {
    const { v, fetchJwks } = verifierWith(() => ({ keys: [K1.jwk] }));
    expect(await v.verify(sign(K1))).toEqual({ ok: true, email: 'owner@example.com' });
    expect(fetchJwks).toHaveBeenCalledWith(`https://${TEAM}/cdn-cgi/access/certs`);
    // The key is cached by kid: a second token makes no second fetch.
    expect(await v.verify(sign(K1, { aud: AUD, email: undefined }))).toEqual({ ok: true });
    expect(fetchJwks).toHaveBeenCalledTimes(1);
  });

  test('rejects a wrong aud', async () => {
    const { v } = verifierWith(() => ({ keys: [K1.jwk] }));
    expect(await v.verify(sign(K1, { aud: ['b'.repeat(64)] }))).toEqual({ ok: false, reason: 'aud' });
    expect(await v.verify(sign(K1, { aud: 'b'.repeat(64) }))).toEqual({ ok: false, reason: 'aud' });
    expect(await v.verify(sign(K1, { aud: undefined }))).toEqual({ ok: false, reason: 'aud' });
  });

  test('rejects a wrong iss', async () => {
    const { v } = verifierWith(() => ({ keys: [K1.jwk] }));
    expect(await v.verify(sign(K1, { iss: 'https://evil.cloudflareaccess.com' }))).toEqual({ ok: false, reason: 'iss' });
    expect(await v.verify(sign(K1, { iss: `https://${TEAM}/` }))).toEqual({ ok: false, reason: 'iss' });
  });

  test('rejects an expired token', async () => {
    const { v } = verifierWith(() => ({ keys: [K1.jwk] }));
    expect(await v.verify(sign(K1, { exp: NOW - 61 }))).toEqual({ ok: false, reason: 'expired' });
    // 60 s of clock tolerance.
    expect((await v.verify(sign(K1, { exp: NOW - 59 }))).ok).toBe(true);
    expect(await v.verify(sign(K1, { exp: undefined }))).toEqual({ ok: false, reason: 'expired' });
  });

  test('rejects a token that is not yet valid, with 60 s of tolerance', async () => {
    const { v } = verifierWith(() => ({ keys: [K1.jwk] }));
    expect(await v.verify(sign(K1, { nbf: NOW + 61 }))).toEqual({ ok: false, reason: 'not-yet-valid' });
    expect((await v.verify(sign(K1, { nbf: NOW + 59 }))).ok).toBe(true);
  });

  test('rejects alg none and HS256', async () => {
    const { v, fetchJwks } = verifierWith(() => ({ keys: [K1.jwk] }));
    const body = b64({ aud: [AUD], iss: `https://${TEAM}`, exp: NOW + 300 });
    const none = `${b64({ alg: 'none', kid: 'k1' })}.${body}.`;
    expect(await v.verify(none)).toEqual({ ok: false, reason: 'alg' });
    // HS256 with the public key as the secret: the classic key-confusion attack.
    const head = b64({ alg: 'HS256', kid: 'k1' });
    const mac = createHmac('sha256', JSON.stringify(K1.jwk)).update(`${head}.${body}`).digest('base64url');
    expect(await v.verify(`${head}.${body}.${mac}`)).toEqual({ ok: false, reason: 'alg' });
    expect(await v.verify(sign(K1, {}, { alg: 'RS512' }))).toEqual({ ok: false, reason: 'alg' });
    // Refused before any key fetch.
    expect(fetchJwks).not.toHaveBeenCalled();
  });

  test('rejects a malformed token', async () => {
    const { v } = verifierWith(() => ({ keys: [K1.jwk] }));
    for (const bad of ['', 'a.b', 'a.b.c.d', 'not a jwt', `${b64('{')}.${b64({})}.x`, `${b64({ alg: 'RS256', kid: 'k1' })}.${b64('[1]')}.x`]) {
      expect(await v.verify(bad)).toEqual({ ok: false, reason: 'malformed' });
    }
    expect(await v.verify('x'.repeat(20_000))).toEqual({ ok: false, reason: 'malformed' });
  });

  test('rejects a token with no kid, and one with a changed payload or a signature by another key', async () => {
    const { v } = verifierWith(() => ({ keys: [K1.jwk] }));
    expect(await v.verify(sign(K1, {}, { kid: undefined }))).toEqual({ ok: false, reason: 'kid' });
    const [h, , s] = sign(K1).split('.');
    const forged = `${h}.${b64({ aud: [AUD], iss: `https://${TEAM}`, exp: NOW + 9999, email: 'evil@example.com' })}.${s}`;
    expect(await v.verify(forged)).toEqual({ ok: false, reason: 'signature' });
    // Signed by K2, but it names K1's kid.
    expect(await v.verify(sign({ kid: 'k1', privateKey: K2.privateKey }))).toEqual({ ok: false, reason: 'signature' });
  });

  test('refetches once for an unknown kid, then rejects', async () => {
    let keys = [K1.jwk];
    const { v, fetchJwks, at } = verifierWith(() => ({ keys }));
    expect((await v.verify(sign(K1))).ok).toBe(true);
    expect(fetchJwks).toHaveBeenCalledTimes(1);
    // Unknown kid: one refetch, and the key is still not there.
    expect(await v.verify(sign(K2))).toEqual({ ok: false, reason: 'kid' });
    expect(fetchJwks).toHaveBeenCalledTimes(2);
    // More tokens with an unknown kid inside 60 s make no more fetches.
    expect(await v.verify(sign(K2))).toEqual({ ok: false, reason: 'kid' });
    expect(await v.verify(sign(makeKey('k3')))).toEqual({ ok: false, reason: 'kid' });
    expect(fetchJwks).toHaveBeenCalledTimes(2);
    // Cloudflare rotates the key. After 60 s the next unknown kid refetches and passes.
    keys = [K1.jwk, K2.jwk];
    at.t += 61_000;
    expect((await v.verify(sign(K2, { exp: NOW + 600 }))).ok).toBe(true);
    expect(fetchJwks).toHaveBeenCalledTimes(3);
    // The old key still works from the cache.
    expect((await v.verify(sign(K1, { exp: NOW + 600 }))).ok).toBe(true);
    expect(fetchJwks).toHaveBeenCalledTimes(3);
  });

  test('fails closed when the key fetch fails and no key is cached', async () => {
    const { v, fetchJwks, log, at } = verifierWith(() => { throw new Error('network down'); });
    expect(await v.verify(sign(K1))).toEqual({ ok: false, reason: 'jwks-unavailable' });
    expect(await v.verify(sign(K1))).toEqual({ ok: false, reason: 'jwks-unavailable' });
    // One fetch per 60 s, and one log line per 60 s.
    expect(fetchJwks).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toMatch(/Cloudflare Access/);
    at.t += 61_000;
    expect(await v.verify(sign(K1, { exp: NOW + 600 }))).toEqual({ ok: false, reason: 'jwks-unavailable' });
    expect(fetchJwks).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(2);
  });

  test('a key set with no usable RSA key gives jwks-unavailable, and a cached key outlives a later fetch failure', async () => {
    const empty = verifierWith(() => ({ keys: [{ kty: 'EC', kid: 'k1' }] } as Jwks));
    expect(await empty.v.verify(sign(K1))).toEqual({ ok: false, reason: 'kid' });
    const junk = verifierWith(() => ({ nope: true } as unknown as Jwks));
    expect(await junk.v.verify(sign(K1))).toEqual({ ok: false, reason: 'jwks-unavailable' });

    let fail = false;
    const { v, at } = verifierWith(() => { if (fail) throw new Error('down'); return { keys: [K1.jwk] }; });
    expect((await v.verify(sign(K1))).ok).toBe(true);
    fail = true;
    at.t += 61_000;
    expect((await v.verify(sign(K1, { exp: NOW + 600 }))).ok).toBe(true);
    expect(await v.verify(sign(K2, { exp: NOW + 600 }))).toEqual({ ok: false, reason: 'jwks-unavailable' });
  });

  test('two tokens that arrive together share one key fetch', async () => {
    const { v, fetchJwks } = verifierWith(() => ({ keys: [K1.jwk] }));
    const [a, b] = await Promise.all([v.verify(sign(K1)), v.verify(sign(K1))]);
    expect(a.ok && b.ok).toBe(true);
    expect(fetchJwks).toHaveBeenCalledTimes(1);
  });
});

describe('parseCloudflareAccess', () => {
  test('takes a team domain and an aud tag, in any case, with or without https://', () => {
    expect(parseCloudflareAccess({ teamDomain: 'https://Acme.CloudflareAccess.com/', aud: AUD })).toEqual({ teamDomain: TEAM, aud: AUD });
    expect(parseCloudflareAccess({ teamDomain: TEAM, aud: ` ${AUD} ` })).toEqual({ teamDomain: TEAM, aud: AUD });
  });
  test('refuses another domain, a path, a short tag and junk', () => {
    for (const teamDomain of ['acme.example.com', 'cloudflareaccess.com', 'acme.cloudflareaccess.com.evil.com', 'acme.cloudflareaccess.com/x', 'a b.cloudflareaccess.com', '', undefined]) {
      expect(parseCloudflareAccess({ teamDomain, aud: AUD })).toBeNull();
    }
    for (const aud of ['', 'short', 'has space'.repeat(8), undefined, 5]) {
      expect(parseCloudflareAccess({ teamDomain: TEAM, aud })).toBeNull();
    }
    expect(parseCloudflareAccess(null)).toBeNull();
    expect(parseCloudflareAccess('x')).toBeNull();
  });
});
