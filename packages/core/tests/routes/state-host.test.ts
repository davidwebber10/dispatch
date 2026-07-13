import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';

// The REAL predicate stays in force (this suite asserts genuine end-to-end capability); canReveal
// is merely wrapped in a spy so we can inspect the client the route hands it — which is how we
// prove the route reads the socket peer address and not req.ip.
vi.mock('../../src/files/reveal.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/files/reveal.js')>();
  return { ...actual, canReveal: vi.fn(actual.canReveal) };
});

import { canReveal } from '../../src/files/reveal.js';
import { createApp } from '../../src/server.js';
import { initSchema } from '../../src/db/schema.js';

describe('GET /api/state/host', () => {
  let app: any;

  beforeEach(() => {
    const db = new Database(':memory:');
    initSchema(db);
    app = createApp({ db, skipPty: true });
    vi.mocked(canReveal).mockClear();
  });

  it('reports the platform and the reveal capability', async () => {
    const res = await request(app).get('/api/state/host');
    expect(res.status).toBe(200);
    expect(res.body.platform).toBe(process.platform);
    // supertest connects over loopback and sends `Host: 127.0.0.1:<port>` with no forwarding
    // headers — the genuinely-local browser. On macOS that is capable.
    expect(res.body.canReveal).toBe(process.platform === 'darwin');
  });

  it('decides capability from the socket peer address, not req.ip', async () => {
    // `trust proxy` makes Express derive req.ip from X-Forwarded-For, so req.ip is now '8.8.8.8'
    // while the kernel-supplied socket peer stays loopback. Without this the two coincide and the
    // assertion certifies nothing.
    app.set('trust proxy', true);
    await request(app).get('/api/state/host').set('X-Forwarded-For', '8.8.8.8');

    const [client] = vi.mocked(canReveal).mock.calls[0];
    expect(client.remoteAddress).toMatch(/^(::1|::ffff:127\.|127\.)/);
    expect(client.remoteAddress).not.toBe('8.8.8.8');   // req.ip would be exactly this
  });

  it('is not fooled by a forged X-Forwarded-For', async () => {
    // A forwarding header means a proxy is in front, which means the browser is NOT on this Mac.
    // Fail closed — whatever the header claims, and whatever the socket says.
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
    // cloudflared runs on this Mac and dials http://localhost:3456, so the daemon sees a real
    // loopback peer for a browser anywhere in the world. The Host header is what gives it away.
    const res = await request(app).get('/api/state/host').set('Host', 'dispatch.example.com');
    expect(res.body.canReveal).toBe(false);
  });

  it('refuses a `tailscale serve` Host, which has the same same-host-proxy topology', async () => {
    const res = await request(app).get('/api/state/host').set('Host', 'mymac.tail1234.ts.net');
    expect(res.body.canReveal).toBe(false);
  });
});
