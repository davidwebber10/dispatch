import { describe, expect, test } from 'vitest';
import express from 'express';
import request from 'supertest';
import { securityHeaders, contentSecurityPolicy } from './security-headers.js';

describe('securityHeaders', () => {
  const app = express();
  app.use(securityHeaders);
  app.get('/ok', (_req, res) => { res.send('x'); });
  app.get('/nf', (_req, res) => { res.status(404).send('x'); });

  test.each(['/ok', '/nf'])('sets the headers on %s', async (p) => {
    const r = await request(app).get(p);
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['referrer-policy']).toBe('same-origin');
  });

  test("Express's own 404 page still carries X-Frame-Options (it replaces the CSP with its own)", async () => {
    const r = await request(app).get('/missing');
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('contentSecurityPolicy', () => {
  const directives = (csp: string) => Object.fromEntries(csp.split('; ').map((d) => { const [k, ...v] = d.split(' '); return [k, v]; }));

  test('scripts come from the app only, and nothing may frame it', () => {
    const d = directives(contentSecurityPolicy('localhost:3456'));
    expect(d['script-src']).toEqual(["'self'"]);
    expect(d['default-src']).toEqual(["'self'"]);
    expect(d['object-src']).toEqual(["'none'"]);
    expect(d['frame-ancestors']).toEqual(["'none'"]);
    expect(d['form-action']).toEqual(["'self'"]);
    expect(d['base-uri']).toEqual(["'self'"]);
  });

  test('connect-src is the app origin and its own WebSocket address only', () => {
    const d = directives(contentSecurityPolicy('localhost:3456'));
    expect(d['connect-src']).toEqual(["'self'", 'ws://localhost:3456', 'wss://localhost:3456']);
  });

  test('a Host header with CSP syntax in it adds nothing', () => {
    for (const bad of ["x; script-src *", "a b", "x'y", 'x\ny']) {
      expect(directives(contentSecurityPolicy(bad))['connect-src']).toEqual(["'self'"]);
    }
    expect(directives(contentSecurityPolicy(undefined))['connect-src']).toEqual(["'self'"]);
  });

  test('image sources include remote http(s) (the Load image click needs it) but not scripts', () => {
    const d = directives(contentSecurityPolicy('localhost:3456'));
    expect(d['img-src']).toEqual(expect.arrayContaining(["'self'", 'data:', 'blob:', 'https:']));
    expect(d['script-src']).not.toContain('https:');
  });
});
