import { describe, expect, test } from 'vitest';
import express from 'express';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { AddressInfo } from 'node:net';
import { BOX_TOKEN_HEADER, tokenMatches, requireBoxToken, upgradeAllowed, createBoxGate } from './box-token.js';
import { KeyRegistry } from './principals.js';
import { createPrincipalMiddleware, principalOf } from './request-principal.js';
import { nullKeyScope } from './key-scope.js';
import request from 'supertest';

describe('tokenMatches', () => {
  test('accepts the exact token', () => {
    expect(tokenMatches('s3cret', 's3cret')).toBe(true);
  });
  test('rejects wrong, empty and missing values', () => {
    expect(tokenMatches('s3cret', 'nope')).toBe(false);
    expect(tokenMatches('s3cret', '')).toBe(false);
    expect(tokenMatches('s3cret', undefined)).toBe(false);
  });
  test('rejects a prefix without throwing on length mismatch', () => {
    // timingSafeEqual throws on unequal lengths; hashing first is what avoids that.
    expect(tokenMatches('s3cret', 's3')).toBe(false);
    expect(tokenMatches('s3cret', 's3cretlonger')).toBe(false);
  });
});

describe('requireBoxToken', () => {
  test('returns undefined when no token is configured (local daemon unaffected)', () => {
    expect(requireBoxToken(undefined)).toBeUndefined();
    expect(requireBoxToken('')).toBeUndefined();
  });

  test('401s a request with no or wrong token, passes a correct one', async () => {
    const app = express();
    app.use(requireBoxToken('s3cret')!);
    app.get('/api/sessions', (_req, res) => { res.json({ ok: true }); });
    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;

    const call = (headers: Record<string, string> = {}) =>
      new Promise<number>((resolve) => {
        http.get({ port, path: '/api/sessions', headers }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
      });

    expect(await call()).toBe(401);
    expect(await call({ [BOX_TOKEN_HEADER]: 'wrong' })).toBe(401);
    expect(await call({ [BOX_TOKEN_HEADER]: 's3cret' })).toBe(200);
    server.close();
  });
});

describe('upgradeAllowed — the easy-to-miss half', () => {
  test('allows everything when unconfigured', () => {
    expect(upgradeAllowed(undefined, { headers: {} } as any)).toBe(true);
  });

  test('gates on the header', () => {
    expect(upgradeAllowed('s3cret', { headers: {} } as any)).toBe(false);
    expect(upgradeAllowed('s3cret', { headers: { [BOX_TOKEN_HEADER]: 'nope' } } as any)).toBe(false);
    expect(upgradeAllowed('s3cret', { headers: { [BOX_TOKEN_HEADER]: 's3cret' } } as any)).toBe(true);
  });

  test('an unauthenticated WebSocket upgrade is refused end-to-end', async () => {
    // The regression that matters: Express middleware does NOT run for upgrades, so a
    // terminal/structured socket would be reachable with no credential at all.
    const server = http.createServer();
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      if (!upgradeAllowed('s3cret', req)) { socket.destroy(); return; }
      wss.handleUpgrade(req, socket as any, head, (ws) => ws.close());
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as AddressInfo).port;

    const attempt = (headers: Record<string, string>) =>
      new Promise<'upgraded' | 'refused'>((resolve) => {
        const req = http.request({
          port, path: '/api/terminals/t1/ws',
          headers: {
            Connection: 'Upgrade', Upgrade: 'websocket',
            'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13',
            ...headers,
          },
        });
        req.on('upgrade', () => resolve('upgraded'));
        req.on('error', () => resolve('refused'));
        req.on('close', () => resolve('refused'));
        req.end();
      });

    expect(await attempt({})).toBe('refused');
    expect(await attempt({ [BOX_TOKEN_HEADER]: 's3cret' })).toBe('upgraded');
    server.close(); wss.close();
  });
});

describe('createBoxGate', () => {
  function build() {
    const registry = new KeyRegistry();
    const getToken = () => 'access-token-value';
    const app = express();
    app.use(createBoxGate({ boxToken: 's3cret', registry, getToken }));
    app.use(createPrincipalMiddleware({ registry, scope: nullKeyScope, getToken, boxToken: 's3cret' }));
    app.get('/api/p', (req, res) => { res.json(principalOf(req)); });
    return { app, registry };
  }
  test('box header passes as owner', async () => {
    const r = await request(build().app).get('/api/p').set(BOX_TOKEN_HEADER, 's3cret');
    expect(r.body).toEqual({ kind: 'owner', via: 'box' });
  });
  test('the access token passes as owner', async () => {
    const r = await request(build().app).get('/api/p').set('Authorization', 'Bearer access-token-value');
    expect(r.body).toEqual({ kind: 'owner', via: 'token' });
  });
  test('a live key passes as the key', async () => {
    const { app, registry } = build();
    const { key } = registry.mint({ kind: 'thread', terminalId: 't1' });
    const r = await request(app).get('/api/p').set('Authorization', `Bearer ${key}`);
    expect(r.body.kind).toBe('thread');
  });
  test('a revoked key and no credential get 401', async () => {
    const { app, registry } = build();
    const { key, handle } = registry.mint({ kind: 'thread', terminalId: 't1' });
    registry.revoke(handle);
    expect((await request(app).get('/api/p').set('Authorization', `Bearer ${key}`)).status).toBe(401);
    const none = await request(app).get('/api/p');
    expect(none.status).toBe(401);
    expect(none.body).toEqual({ error: 'unauthorized' });
  });
  test('a key plus the box header is judged as the key', async () => {
    const { app, registry } = build();
    const { key } = registry.mint({ kind: 'thread', terminalId: 't1' });
    const r = await request(app).get('/api/p').set(BOX_TOKEN_HEADER, 's3cret').set('Authorization', `Bearer ${key}`);
    expect(r.body.kind).toBe('thread');
    const { key: k2, handle } = registry.mint({ kind: 'thread', terminalId: 't2' });
    registry.revoke(handle);
    const bad = await request(app).get('/api/p').set(BOX_TOKEN_HEADER, 's3cret').set('Authorization', `Bearer ${k2}`);
    expect(bad.status).toBe(401);
  });
});
