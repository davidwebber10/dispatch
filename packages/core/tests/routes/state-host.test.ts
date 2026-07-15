import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';

import { platform } from '../../src/platform/index.js';
import { createApp } from '../../src/server.js';
import { initSchema } from '../../src/db/schema.js';

describe('GET /api/state/host', () => {
  let app: any;
  let isLocalClientSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    const db = new Database(':memory:');
    initSchema(db);
    app = createApp({ db, skipPty: true });
    // Wraps the REAL predicate (this suite asserts genuine end-to-end capability) — the spy only
    // exists so tests can inspect the client the route hands it, which is how we prove the route
    // reads the socket peer address and not req.ip.
    isLocalClientSpy = vi.spyOn(platform, 'isLocalClient');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports the platform, flavor, file manager, and reveal capability', async () => {
    const res = await request(app).get('/api/state/host');
    expect(res.status).toBe(200);
    expect(res.body.platform).toBe(process.platform);
    expect(res.body.flavor).toBe(platform.flavor);
    expect(res.body.fileManagerName).toBe(platform.fileManagerName);
    expect(typeof res.body.canReveal).toBe('boolean');
  });

  it('decides capability from the socket peer address, not req.ip', async () => {
    // `trust proxy` makes Express derive req.ip from X-Forwarded-For, so req.ip is now '8.8.8.8'
    // while the kernel-supplied socket peer stays loopback. Without this the two coincide and the
    // assertion certifies nothing.
    app.set('trust proxy', true);
    await request(app).get('/api/state/host').set('X-Forwarded-For', '8.8.8.8');

    const [client] = isLocalClientSpy.mock.calls[0];
    expect(client.remoteAddress).toMatch(/^(::1|::ffff:127\.|127\.)/);
    expect(client.remoteAddress).not.toBe('8.8.8.8');   // req.ip would be exactly this
  });

  it('is not fooled by a forged X-Forwarded-For', async () => {
    // A forwarding header means a proxy is in front, which means the browser is NOT on this
    // machine. Fail closed — whatever the header claims, and whatever the socket says.
    app.set('trust proxy', true);
    const res = await request(app).get('/api/state/host').set('X-Forwarded-For', '127.0.0.1');
    expect(res.body.canReveal).toBe(false);
  });

  it('refuses a Cloudflare-proxied request (cf-connecting-ip, loopback socket, loopback Host)', async () => {
    // Express's trust proxy ignores cf-connecting-ip entirely, so req.ip here is 127.0.0.1 and the
    // Host is loopback: only the explicit proxy-header check catches this one.
    app.set('trust proxy', true);
    const res = await request(app).get('/api/state/host').set('CF-Connecting-IP', '8.8.8.8');
    expect(res.body.canReveal).toBe(false);
  });

  it('THE TUNNEL CASE: refuses a loopback socket carrying a public Host header', async () => {
    // cloudflared runs on this machine and dials http://localhost:3456, so the daemon sees a real
    // loopback peer for a browser anywhere in the world. The Host header is what gives it away.
    const res = await request(app).get('/api/state/host').set('Host', 'dispatch.example.com');
    expect(res.body.canReveal).toBe(false);
  });

  it('refuses a `tailscale serve` Host, which has the same same-host-proxy topology', async () => {
    const res = await request(app).get('/api/state/host').set('Host', 'mymac.tail1234.ts.net');
    expect(res.body.canReveal).toBe(false);
  });
});
