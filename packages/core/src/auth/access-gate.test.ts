import { beforeEach, describe, expect, test } from 'vitest';
import { decide, type GateDeps, type GateRequest } from './access-gate.js';
import { cookieValue, COOKIE_NAME } from './access-token.js';

const TOKEN = 'tok-tok-tok';
const GATEWAY = '172.20.0.1';

let allowedHosts: string[];
let allowedOrigins: string[];
let ownerPeers: Set<string>;

function deps(): GateDeps {
  return {
    getToken: () => TOKEN,
    isGatewayPeer: (a) => a === GATEWAY,
    config: {
      allowedHosts: () => allowedHosts, allowedOrigins: () => allowedOrigins,
      addHost() {}, removeHost() {},
    },
    tailscale: {
      self: async () => ({ userId: 1, names: ['mac.tail1.ts.net', 'mac'], ips: ['100.64.0.9'] }),
      isOwnerPeer: async (a) => ownerPeers.has(a ?? ''),
    },
  };
}
const req = (o: Partial<GateRequest>): GateRequest => ({
  remoteAddress: '127.0.0.1', host: 'localhost:3456', origin: undefined, secFetchSite: undefined,
  authorization: undefined, cookie: undefined, tailscaleUserLogin: undefined, tailscaleFunnel: undefined,
  isApi: true, isUpgrade: false, ...o,
});
const ok = (r: Partial<GateRequest>) => decide(req(r), deps()).then((d) => d.ok);
const status = (r: Partial<GateRequest>) => decide(req(r), deps()).then((d) => (d.ok ? 200 : `${d.status}:${d.error}`));

beforeEach(() => { allowedHosts = []; allowedOrigins = []; ownerPeers = new Set(['100.64.0.2']); });

describe('local peer with a known host', () => {
  test.each([
    ['127.0.0.1', 'localhost:3456'], ['127.0.0.1', '127.0.0.1:3456'], ['::1', '[::1]:3456'],
    ['::ffff:127.0.0.1', 'localhost'], ['127.0.0.5', '127.0.0.5:3456'],
  ])('%s with Host %s passes', async (remoteAddress, host) => {
    expect(await ok({ remoteAddress, host })).toBe(true);
  });
  test('DNS rebinding: loopback peer with a foreign Host is refused', async () => {
    expect(await status({ host: 'evil.example:3456' })).toBe('401:auth_required');
    expect(await status({ host: undefined })).toBe('401:auth_required');
  });
  test('the .local name and a LAN address are not known hosts', async () => {
    expect(await status({ host: 'mac.local:3456' })).toBe('401:auth_required');
    expect(await status({ host: '192.168.1.9:3456' })).toBe('401:auth_required');
  });
});

describe('remote peers', () => {
  test('LAN peer is refused whatever the Host', async () => {
    expect(await status({ remoteAddress: '192.168.1.9', host: 'localhost:3456' })).toBe('401:auth_required');
    expect(await status({ remoteAddress: '192.168.1.9', host: '192.168.1.5:3456' })).toBe('401:auth_required');
  });
  test('bearer token and good cookie pass from the LAN', async () => {
    const lan = { remoteAddress: '192.168.1.9', host: '192.168.1.5:3456' };
    expect(await ok({ ...lan, authorization: `Bearer ${TOKEN}` })).toBe(true);
    expect(await ok({ ...lan, cookie: `${COOKIE_NAME}=${cookieValue(TOKEN)}` })).toBe(true);
  });
  test('wrong bearer, wrong cookie, the raw token as a cookie and a non-bearer scheme are refused', async () => {
    const lan = { remoteAddress: '192.168.1.9', host: '192.168.1.5:3456' };
    expect(await ok({ ...lan, authorization: 'Bearer nope' })).toBe(false);
    expect(await ok({ ...lan, authorization: `Basic ${TOKEN}` })).toBe(false);
    expect(await ok({ ...lan, cookie: `${COOKIE_NAME}=wrong` })).toBe(false);
    expect(await ok({ ...lan, cookie: `${COOKIE_NAME}=${TOKEN}` })).toBe(false);
  });
});

describe('WSL gateway peer', () => {
  test('passes with a loopback Host, refused with a foreign Host', async () => {
    expect(await ok({ remoteAddress: GATEWAY, host: 'localhost:3456' })).toBe(true);
    expect(await ok({ remoteAddress: GATEWAY, host: 'evil.example' })).toBe(false);
  });
  test('a private non-gateway peer with Host localhost is refused', async () => {
    expect(await ok({ remoteAddress: '172.20.0.7', host: 'localhost:3456' })).toBe(false);
  });
});

describe('tailscale serve (loopback peer, ts.net Host)', () => {
  const serve = { host: 'mac.tail1.ts.net', remoteAddress: '127.0.0.1' };
  test('identity header present: passes', async () => {
    expect(await ok({ ...serve, tailscaleUserLogin: 'me@example.com', origin: 'https://mac.tail1.ts.net' })).toBe(true);
  });
  test('no identity header: refused', async () => { expect(await ok(serve)).toBe(false); });
  test('Funnel request: refused even with an identity-looking header', async () => {
    expect(await ok({ ...serve, tailscaleUserLogin: 'me@example.com', tailscaleFunnel: '?1' })).toBe(false);
  });
});

describe('tailscale direct', () => {
  const owner = { remoteAddress: '100.64.0.2' };
  test('owner device with a tailnet Host passes', async () => {
    for (const host of ['mac.tail1.ts.net:3456', 'mac:3456', '100.64.0.9:3456']) {
      expect(await ok({ ...owner, host })).toBe(true);
    }
  });
  test('another user, or any non-owner tailnet address, is refused', async () => {
    expect(await ok({ remoteAddress: '100.64.0.3', host: 'mac.tail1.ts.net:3456' })).toBe(false);
  });
  test('owner device with a foreign or LAN-style Host is refused', async () => {
    expect(await ok({ ...owner, host: 'evil.example:3456' })).toBe(false);
    expect(await ok({ ...owner, host: '192.168.1.5:3456' })).toBe(false);
  });
});

describe('allow-host', () => {
  test('passes from loopback; does not help a LAN peer; removal stops it', async () => {
    allowedHosts = ['proxy.example.com'];
    expect(await ok({ host: 'proxy.example.com' })).toBe(true);
    expect(await ok({ remoteAddress: '192.168.1.9', host: 'proxy.example.com' })).toBe(false);
    allowedHosts = [];
    expect(await ok({ host: 'proxy.example.com' })).toBe(false);
  });
});

describe('Origin check', () => {
  test('no Origin passes (curl, hooks, navigations)', async () => { expect(await ok({})).toBe(true); });
  test.each(['GET', 'POST', 'upgrade'])('foreign Origin is refused (%s)', async (kind) => {
    expect(await status({ origin: 'http://evil.example', isUpgrade: kind === 'upgrade', secFetchSite: 'cross-site' }))
      .toBe('403:origin_refused');
    expect(await status({ origin: 'http://evil.example', isUpgrade: kind === 'upgrade' })).toBe('403:origin_refused');
  });
  test('Origin: null is refused', async () => { expect(await status({ origin: 'null' })).toBe('403:origin_refused'); });
  test('same origin passes', async () => {
    expect(await ok({ origin: 'http://localhost:3456', secFetchSite: 'same-origin' })).toBe(true);
  });
  test('same name, different port is not the same origin', async () => {
    expect(await ok({ origin: 'http://localhost:3999', secFetchSite: 'same-site' })).toBe(false);
  });
  test('Vite dev server: loopback origin on another port passes only as same-origin or unmarked', async () => {
    const vite = { origin: 'http://localhost:5173' };
    expect(await ok({ ...vite, secFetchSite: 'same-origin' })).toBe(true);
    expect(await ok({ ...vite })).toBe(true);
    expect(await ok({ ...vite, secFetchSite: 'same-site' })).toBe(false);
    expect(await ok({ ...vite, secFetchSite: 'cross-site' })).toBe(false);
  });
  test('cross-site /api request with no Origin (img, no-cors GET) is refused; page navigation is not', async () => {
    expect(await status({ secFetchSite: 'cross-site', isApi: true })).toBe('403:origin_refused');
    expect(await ok({ secFetchSite: 'cross-site', isApi: false })).toBe(true);
    expect(await ok({ secFetchSite: 'none', isApi: true })).toBe(true);
  });
  test('a signed-in browser that visits an evil page is still refused (SEC-03)', async () => {
    const cookie = `${COOKIE_NAME}=${cookieValue(TOKEN)}`;
    expect(await status({ remoteAddress: '192.168.1.9', host: '192.168.1.5:3456', cookie, origin: 'http://evil.example' }))
      .toBe('403:origin_refused');
  });
  test('an origin listed in access.json passes', async () => {
    allowedOrigins = ['https://good.example'];
    expect(await ok({ origin: 'https://good.example', secFetchSite: 'cross-site' })).toBe(true);
  });
  test('a LAN origin matching the Host passes with a credential', async () => {
    expect(await ok({
      remoteAddress: '192.168.1.9', host: '192.168.1.5:3456', origin: 'http://192.168.1.5:3456',
      secFetchSite: 'same-origin', authorization: `Bearer ${TOKEN}`,
    })).toBe(true);
  });
});
