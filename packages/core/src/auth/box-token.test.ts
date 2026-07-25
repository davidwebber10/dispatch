import { describe, expect, test } from 'vitest';
import express from 'express';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { AddressInfo } from 'node:net';
import { BOX_TOKEN_HEADER, tokenMatches, requireBoxToken, upgradeAllowed } from './box-token.js';

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
