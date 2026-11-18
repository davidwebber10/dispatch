// Box defect #9 (2026-11-11): a WebSocket upgrade without the box token got an empty, dropped socket.
// It must get a real 401 answer.
import { afterEach, describe, expect, test } from 'vitest';
import net from 'node:net';
import { closeKits, kit } from './kit.js';

afterEach(() => closeKits());

function rawUpgrade(port: number, path: string, headers: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => {
      const h = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
      s.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${h}\r\n`);
    });
    let buf = '';
    s.on('data', (d) => { buf += d.toString(); });
    s.on('close', () => resolve(buf));
    s.on('error', reject);
    setTimeout(() => { s.destroy(); resolve(buf); }, 1500);
  });
}

describe('hosted WebSocket refusals', () => {
  test('no box token: HTTP 401, not an empty reply; a wrong prefix: 404', async () => {
    const k = kit({ auth: 'gate', env: { ...process.env, DISPATCH_BOX_TOKEN: 'tok', DISPATCH_BASE_PATH: '/dispatch' } } as any);
    const port = await k.port();
    expect(await rawUpgrade(port, '/dispatch/api/events')).toMatch(/^HTTP\/1\.1 401 Unauthorized/);
    expect(await rawUpgrade(port, '/elsewhere/api/events', { 'x-dispatch-box-token': 'tok' })).toMatch(/^HTTP\/1\.1 (404|401)/);
  });
});
