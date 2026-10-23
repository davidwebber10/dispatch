import { describe, expect, test } from 'vitest';
import express from 'express';
import request from 'supertest';
import { securityHeaders } from './security-headers.js';

describe('securityHeaders', () => {
  const app = express();
  app.use(securityHeaders);
  app.get('/ok', (_req, res) => { res.send('x'); });
  app.get('/nf', (_req, res) => { res.status(404).send('x'); });

  test.each(['/ok', '/nf'])('sets the headers on %s', async (p) => {
    const r = await request(app).get(p);
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['content-security-policy']).toBe("frame-ancestors 'none'");
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['referrer-policy']).toBe('same-origin');
  });

  test("Express's own 404 page still carries X-Frame-Options (it replaces the CSP with its own)", async () => {
    const r = await request(app).get('/missing');
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
  });
});
