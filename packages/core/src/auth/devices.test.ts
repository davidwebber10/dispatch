import { beforeEach, describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import {
  createDeviceStore, describePeer, deviceNameFromUserAgent, type DeviceStore,
} from './devices.js';
import { cookieValue, deviceCookieValue, parseDeviceCookie } from './access-token.js';

const TOKEN = 'token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const LAN = { addr: '192.168.1.9', kind: 'direct' as const };

let db: Database.Database;
let t: number;
let token: string;
let store: DeviceStore;

beforeEach(() => {
  db = new Database(':memory:');
  initSchema(db);
  t = 1_000_000;
  token = TOKEN;
  store = createDeviceStore(db, { getToken: () => token, now: () => t });
});

describe('device cookie', () => {
  test('round trips and is bound to the token', () => {
    const v = deviceCookieValue(TOKEN, 'abcdefgh12');
    expect(parseDeviceCookie(v)).toEqual({ id: 'abcdefgh12', mac: expect.any(String) });
    expect(v).not.toBe(cookieValue(TOKEN));
    expect(deviceCookieValue('other-token', 'abcdefgh12')).not.toBe(v);
  });
  test('rejects junk', () => {
    expect(parseDeviceCookie('')).toBeNull();
    expect(parseDeviceCookie('v2.only')).toBeNull();
    expect(parseDeviceCookie(cookieValue(TOKEN))).toBeNull(); // the old cookie shape
  });
});

describe('create and verify', () => {
  test('a new device verifies with its own cookie', () => {
    const d = store.create({ userAgent: IPHONE, via: 'code', peer: LAN });
    expect(d.name).toBe('iPhone (Safari)');
    expect(store.verify(deviceCookieValue(TOKEN, d.id))).toEqual({ id: d.id });
  });
  test('a forged mac, another id and a junk cookie fail', () => {
    const d = store.create({ userAgent: IPHONE, via: 'token', peer: LAN });
    expect(store.verify(deviceCookieValue('wrong-token', d.id))).toBeNull();
    expect(store.verify(deviceCookieValue(TOKEN, 'not-a-device'))).toBeNull();
    expect(store.verify('garbage')).toBeNull();
    expect(store.verify(undefined)).toBeNull();
  });
  test('revoke ends only that device', () => {
    const a = store.create({ userAgent: IPHONE, via: 'code', peer: LAN });
    const b = store.create({ userAgent: 'x', via: 'token', peer: LAN });
    expect(store.revoke(a.id)).toBe(true);
    expect(store.verify(deviceCookieValue(TOKEN, a.id))).toBeNull();
    expect(store.verify(deviceCookieValue(TOKEN, b.id))).toEqual({ id: b.id });
    expect(store.revoke(a.id)).toBe(false); // already gone
  });
  test('revoke tells the listener, so open sockets can close', () => {
    const seen: string[] = [];
    store.onRevoke((id) => seen.push(id));
    const a = store.create({ userAgent: 'x', via: 'code', peer: LAN });
    store.revoke(a.id);
    expect(seen).toEqual([a.id]);
  });
  test('rotating the token ends every device, and the list drops them', () => {
    const a = store.create({ userAgent: IPHONE, via: 'code', peer: LAN });
    token = 'a-brand-new-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    expect(store.verify(deviceCookieValue(TOKEN, a.id))).toBeNull();
    expect(store.verify(deviceCookieValue(token, a.id))).toBeNull(); // record is for the old token
    expect(store.list()).toEqual([]);
  });
  test('stores no cookie secret: the row has the id, not the cookie', () => {
    const d = store.create({ userAgent: IPHONE, via: 'code', peer: LAN });
    const dump = JSON.stringify(db.prepare('SELECT * FROM devices').all());
    expect(dump).not.toContain(deviceCookieValue(TOKEN, d.id));
    expect(dump).not.toContain(TOKEN);
  });
});

describe('list, rename, touch', () => {
  test('lists newest activity first with the fields the page needs', () => {
    const a = store.create({ userAgent: IPHONE, via: 'code', peer: LAN });
    t += 5000;
    const b = store.create({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0 Safari/537.36', via: 'token', peer: { addr: '100.64.0.2', kind: 'forwarded' } });
    const list = store.list();
    expect(list.map((d) => d.id)).toEqual([b.id, a.id]);
    expect(list[0]).toMatchObject({ name: 'Mac (Chrome)', signedInVia: 'token', createdAt: t, lastSeenAt: t, lastAddress: '100.64.0.2', addressKind: 'forwarded' });
  });
  test('rename trims, caps length, and refuses an empty name', () => {
    const a = store.create({ userAgent: IPHONE, via: 'code', peer: LAN });
    expect(store.rename(a.id, '  Jason iPhone  ')).toBe(true);
    expect(store.list()[0].name).toBe('Jason iPhone');
    expect(store.rename(a.id, '   ')).toBe(false);
    store.rename(a.id, 'x'.repeat(200));
    expect(store.list()[0].name.length).toBe(60);
    expect(store.rename('nope', 'y')).toBe(false);
  });
  test('touch updates last seen and address, at most once a minute', () => {
    const a = store.create({ userAgent: IPHONE, via: 'code', peer: LAN });
    t += 10_000;
    store.touch(a.id, { addr: '10.0.0.7', kind: 'direct' }, IPHONE);
    expect(store.list()[0].lastSeenAt).toBe(1_000_000); // too soon
    t += 61_000;
    store.touch(a.id, { addr: '10.0.0.7', kind: 'direct' }, IPHONE);
    expect(store.list()[0]).toMatchObject({ lastSeenAt: t, lastAddress: '10.0.0.7' });
  });
  test('keeps at most 100 devices, dropping the least recently seen', () => {
    const first = store.create({ userAgent: 'x', via: 'code', peer: LAN });
    for (let i = 0; i < 100; i++) { t += 1000; store.create({ userAgent: 'x', via: 'code', peer: LAN }); }
    expect(store.list()).toHaveLength(100);
    expect(store.verify(deviceCookieValue(TOKEN, first.id))).toBeNull();
  });
});

describe('older sign-ins (cookie from before the device list)', () => {
  test('allowed by default', () => { expect(store.legacyAllowed()).toBe(true); });
  test('adopt makes one device per browser, even for parallel requests', () => {
    const a = store.adoptLegacy(IPHONE, LAN);
    const b = store.adoptLegacy(IPHONE, LAN);
    expect(b.id).toBe(a.id);
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0].signedInVia).toBe('earlier');
    t += 60_000;
    const c = store.adoptLegacy(IPHONE, LAN);
    expect(c.id).not.toBe(a.id); // a second browser later with the same look is its own device
  });
  test('ending older sign-ins turns the old cookie off and persists', () => {
    store.endLegacy();
    expect(store.legacyAllowed()).toBe(false);
    const again = createDeviceStore(db, { getToken: () => token, now: () => t });
    expect(again.legacyAllowed()).toBe(false);
  });
  test('rotating the token turns the switch back on for the new token', () => {
    store.endLegacy();
    token = 'a-brand-new-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    expect(store.legacyAllowed()).toBe(true); // the old cookies are already dead; a new one is a fresh start
  });
});

describe('describePeer', () => {
  const gw = (a: string | undefined) => a === '172.20.0.1';
  test('a direct LAN peer is its own address', () => {
    expect(describePeer('192.168.1.9', undefined, gw)).toEqual({ addr: '192.168.1.9', kind: 'direct' });
    expect(describePeer('::ffff:192.168.1.9', undefined, gw)).toEqual({ addr: '192.168.1.9', kind: 'direct' });
  });
  test('loopback with no forward header is this computer', () => {
    expect(describePeer('127.0.0.1', undefined, gw)).toEqual({ addr: '127.0.0.1', kind: 'local' });
    expect(describePeer('::1', undefined, gw)).toEqual({ addr: '::1', kind: 'local' });
  });
  test('loopback with a forward header (tailscale serve) is the forwarded client', () => {
    expect(describePeer('127.0.0.1', '100.101.102.103', gw)).toEqual({ addr: '100.101.102.103', kind: 'forwarded' });
  });
  test('the WSL gateway is its own kind, so the page can say it cannot tell', () => {
    expect(describePeer('172.20.0.1', undefined, gw)).toEqual({ addr: '172.20.0.1', kind: 'gateway' });
    expect(describePeer('172.20.0.1', '100.64.0.9', gw)).toEqual({ addr: '100.64.0.9', kind: 'forwarded' });
  });
  test('a forward header from a non-proxy peer is ignored (the client chose it)', () => {
    expect(describePeer('203.0.113.5', '1.2.3.4', gw)).toEqual({ addr: '203.0.113.5', kind: 'direct' });
  });
  test('a junk forward value is ignored', () => {
    expect(describePeer('127.0.0.1', '<script>alert(1)</script>', gw)).toEqual({ addr: '127.0.0.1', kind: 'local' });
    expect(describePeer(undefined, undefined, gw)).toEqual({ addr: 'unknown', kind: 'direct' });
  });
});

describe('deviceNameFromUserAgent', () => {
  test.each([
    [IPHONE, 'iPhone (Safari)'],
    ['Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1', 'iPad (Safari)'],
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36', 'Android (Chrome)'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0', 'Windows (Edge)'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0', 'Windows (Firefox)'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15', 'Mac (Safari)'],
    ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36', 'Linux (Chrome)'],
    ['curl/8.0', 'Unknown device'],
    ['', 'Unknown device'],
    [undefined, 'Unknown device'],
  ])('%s', (ua, name) => { expect(deviceNameFromUserAgent(ua)).toBe(name); });
});
