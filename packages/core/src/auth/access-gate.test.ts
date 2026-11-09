import { beforeEach, describe, expect, test } from 'vitest';
import { decide, type GateDeps, type GateRequest } from './access-gate.js';
import type { CfAccessResult, CloudflareAccessConfig } from './cf-access.js';
import { cookieValue, COOKIE_NAME } from './access-token.js';

const TOKEN = 'tok-tok-tok';
const GATEWAY = '172.20.0.1';

let allowedHosts: string[];
let allowedOrigins: string[];
let ownerPeers: Set<string>;
let cloudflareAccess: CloudflareAccessConfig | null;
/** What the fake verifier saw: the config and the assertion of each call. */
let cfCalls: { config: CloudflareAccessConfig; jwt: string }[];
let cfAnswer: (jwt: string) => CfAccessResult;

function deps(): GateDeps {
  return {
    getToken: () => TOKEN,
    isGatewayPeer: (a) => a === GATEWAY,
    config: {
      allowedHosts: () => allowedHosts, allowedOrigins: () => allowedOrigins,
      addHost() {}, removeHost() {},
      cloudflareAccess: () => cloudflareAccess, setCloudflareAccess() {},
    },
    cfAccess: (config) => ({ verify: async (jwt) => { cfCalls.push({ config, jwt }); return cfAnswer(jwt); } }),
    tailscale: {
      self: async () => ({ userId: 1, login: 'me@example.com', names: ['mac.tail1.ts.net', 'mac'], ips: ['100.64.0.9'] }),
      isOwnerPeer: async (a) => ownerPeers.has(a ?? ''),
    },
  };
}
const req = (o: Partial<GateRequest>): GateRequest => ({
  remoteAddress: '127.0.0.1', host: 'localhost:3456', origin: undefined, secFetchSite: undefined,
  authorization: undefined, cookie: undefined, tailscaleUserLogin: undefined, tailscaleFunnel: undefined, proxied: false, forwardedFor: undefined,
  isApi: true, isUpgrade: false, ...o,
});
const ok = (r: Partial<GateRequest>) => decide(req(r), deps()).then((d) => d.ok);
const status = (r: Partial<GateRequest>) => decide(req(r), deps()).then((d) => (d.ok ? 200 : `${d.status}:${d.error}`));

beforeEach(() => {
  allowedHosts = []; allowedOrigins = []; ownerPeers = new Set(['100.64.0.2']);
  cloudflareAccess = null; cfCalls = [];
  cfAnswer = (jwt) => (jwt === 'good.jwt.sig' ? { ok: true, email: 'me@example.com' } : { ok: false, reason: 'signature' });
});

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
  test('identity header of someone else (shared tailnet): refused', async () => {
    expect(await ok({ ...serve, tailscaleUserLogin: 'stranger@other.com' })).toBe(false);
  });
  test('serve with X-Forwarded-For of an owner device passes; of any other address is refused (forged header behind Caddy)', async () => {
    const id = { ...serve, tailscaleUserLogin: 'me@example.com', proxied: true };
    expect(await ok({ ...id, forwardedFor: '100.64.0.2' })).toBe(true);
    expect(await ok({ ...id, forwardedFor: '203.0.113.9' })).toBe(false);
    expect(await ok({ ...id, forwardedFor: '100.64.0.3' })).toBe(false);
  });
  test('serve identity relayed with Forwarded, X-Real-IP or CF-Connecting-IP but no owner X-Forwarded-For is refused', async () => {
    const id = { ...serve, tailscaleUserLogin: 'me@example.com', proxied: true, forwardedFor: undefined };
    expect(await ok(id)).toBe(false);
  });
  test('present-but-empty relay and funnel headers fail closed', async () => {
    // factsFrom turns a present empty header into proxied=true / forwardedFor=undefined / funnel=''
    const id = { ...serve, tailscaleUserLogin: 'me@example.com' };
    expect(await ok({ ...id, proxied: true, forwardedFor: undefined })).toBe(false);
    expect(await ok({ ...id, tailscaleFunnel: '' })).toBe(false);
  });
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

describe('relayed requests', () => {
  test('a relayed request with Host rewritten to localhost is refused (ngrok, cloudflared, nginx)', async () => {
    for (const proxied of [true]) expect(await ok({ host: 'localhost:3456', proxied })).toBe(false);
  });
  test('a relayed request still passes for an allow-host name and for tailscale serve', async () => {
    allowedHosts = ['proxy.example.com'];
    expect(await ok({ host: 'proxy.example.com', proxied: true })).toBe(true);
    expect(await ok({ host: 'mac.tail1.ts.net', proxied: true, forwardedFor: '100.64.0.2', tailscaleUserLogin: 'me@example.com' })).toBe(true);
  });
  test('a credential still passes when relayed', async () => {
    expect(await ok({ host: 'localhost:3456', proxied: true, authorization: `Bearer ${TOKEN}` })).toBe(true);
  });
});

// W1-C: with `cloudflareAccess` in access.json, an allow-listed host is "this machine" only when
// the request carries an assertion that Cloudflare signed for the owner's team and application.
describe('Cloudflare Access check on an allow-listed host', () => {
  const CF = { teamDomain: 'acme.cloudflareaccess.com', aud: 'a'.repeat(64) };
  // What cloudflared sends: a loopback peer, the public Host, and relay headers.
  const tunnel = { host: 'dispatch.example.com', proxied: true, forwardedFor: '203.0.113.9' };
  beforeEach(() => { allowedHosts = ['dispatch.example.com']; });

  test('with no cloudflareAccess config an allow-listed host is trusted as before', async () => {
    expect(await status(tunnel)).toBe(200);
    expect(await status({ ...tunnel, cfAccessJwt: 'anything' })).toBe(200);
    expect(await status({ host: 'dispatch.example.com' })).toBe(200);
    // The verifier is never asked.
    expect(cfCalls).toEqual([]);
  });

  test('with the config set, an allow-listed host with no assertion gets the sign-in page', async () => {
    cloudflareAccess = CF;
    // 401 auth_required is what the middleware turns into the sign-in page. Never a hard 403.
    expect(await status(tunnel)).toBe('401:auth_required');
    expect(await status({ ...tunnel, cfAccessJwt: '' })).toBe('401:auth_required');
    expect(await status({ ...tunnel, isUpgrade: true })).toBe('401:auth_required');
    expect(cfCalls).toEqual([]);
  });

  test('with the config set, an invalid assertion gets the sign-in page, for every failure reason', async () => {
    cloudflareAccess = CF;
    for (const reason of ['malformed', 'alg', 'kid', 'signature', 'aud', 'iss', 'expired', 'not-yet-valid', 'jwks-unavailable'] as const) {
      cfAnswer = () => ({ ok: false, reason });
      expect(await status({ ...tunnel, cfAccessJwt: 'bad.jwt.sig' })).toBe('401:auth_required');
    }
  });

  test('with the config set and a valid assertion, the host is trusted', async () => {
    cloudflareAccess = CF;
    expect(await status({ ...tunnel, cfAccessJwt: 'good.jwt.sig' })).toBe(200);
    expect(cfCalls).toEqual([{ config: CF, jwt: 'good.jwt.sig' }]);
    // The WebSocket upgrade carries the same header and gets the same answer.
    expect(await status({ ...tunnel, cfAccessJwt: 'good.jwt.sig', isUpgrade: true })).toBe(200);
  });

  test('a loopback host is not affected by the config', async () => {
    cloudflareAccess = CF;
    expect(await status({ host: 'localhost:3456' })).toBe(200);
    expect(await status({ host: '127.0.0.1:3456' })).toBe(200);
    expect(cfCalls).toEqual([]);
  });

  test('with the config set, a cookie or the token still signs in on the allow-listed host', async () => {
    cloudflareAccess = CF;
    expect(await status({ ...tunnel, authorization: `Bearer ${TOKEN}` })).toBe(200);
    expect(await status({ ...tunnel, cookie: `${COOKIE_NAME}=${cookieValue(TOKEN)}` })).toBe(200);
    expect(cfCalls).toEqual([]);
  });

  test('a valid assertion does not vouch for a host that is not allow-listed, or for a remote peer', async () => {
    cloudflareAccess = CF;
    expect(await status({ ...tunnel, host: 'other.example.com', cfAccessJwt: 'good.jwt.sig' })).toBe('401:auth_required');
    expect(await status({ ...tunnel, remoteAddress: '192.168.1.9', cfAccessJwt: 'good.jwt.sig' })).toBe('401:auth_required');
  });

  test('a saved config that is not valid fails closed: the host is never vouched for', async () => {
    cloudflareAccess = { teamDomain: '', aud: '' };
    expect(await status({ ...tunnel, cfAccessJwt: 'good.jwt.sig' })).toBe('401:auth_required');
    expect(cfCalls).toEqual([]);
  });

  test('a Tailscale name that is also allow-listed still passes by its own identity', async () => {
    cloudflareAccess = CF;
    allowedHosts = ['mac.tail1.ts.net'];
    expect(await status({ host: 'mac.tail1.ts.net', tailscaleUserLogin: 'me@example.com', proxied: true, forwardedFor: '100.64.0.2' })).toBe(200);
  });

  test('a verifier that throws counts as not vouched', async () => {
    cloudflareAccess = CF;
    cfAnswer = () => { throw new Error('boom'); };
    expect(await status({ ...tunnel, cfAccessJwt: 'good.jwt.sig' })).toBe('401:auth_required');
  });
});
