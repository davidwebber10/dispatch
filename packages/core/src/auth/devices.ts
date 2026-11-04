import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { deviceCookieValue, parseDeviceCookie, tokenFingerprint } from './access-token.js';
import { tokenMatches } from './box-token.js';
import { isLoopbackAddress } from '../files/reveal.js';

/**
 * Signed-in devices (network exposure spec, 8.1 and 8.2).
 *
 * Every browser that signs in by one-time code, QR code or token gets a row here and a cookie
 * that names it. A request is signed in only if the cookie's MAC is valid for the current access
 * token AND the row still exists, so deleting the row (revoke) ends that one device and nothing
 * else. Rotating the access token ends all of them: the MAC check fails, and the list drops the
 * rows that were made under the old token.
 */
export type SignInMethod = 'code' | 'token' | 'earlier';
/** direct: the peer is the device. local: a request from this computer. gateway: WSL's Windows host
 *  (a Windows browser, or a LAN device through a portproxy; Dispatch cannot tell which).
 *  forwarded: a same-machine proxy such as `tailscale serve` named the client. */
export type AddressKind = 'direct' | 'local' | 'gateway' | 'forwarded';
export interface Peer { addr: string; kind: AddressKind }

export interface DeviceInfo {
  id: string;
  name: string;
  signedInVia: SignInMethod;
  createdAt: number;
  lastSeenAt: number;
  lastAddress: string | null;
  addressKind: AddressKind | null;
}

export interface DeviceStore {
  create(input: { userAgent: string | undefined; via: 'code' | 'token'; peer: Peer }): DeviceInfo;
  /** A browser that held the pre-device-list cookie: make (or reuse, for parallel requests) its device. */
  adoptLegacy(userAgent: string | undefined, peer: Peer): DeviceInfo;
  /** The device a device cookie names, or null. Constant-time MAC check, then the row must exist for this token. */
  verify(cookie: string | undefined): { id: string } | null;
  /** Record that the device was seen. Writes at most once a minute per device. */
  touch(id: string, peer: Peer, userAgent: string | undefined): void;
  list(): DeviceInfo[];
  rename(id: string, name: string): boolean;
  revoke(id: string): boolean;
  /** Called for every row that goes away (revoke, cap eviction, stale-token prune), so the server can close that device's open sockets. */
  onRevoke(fn: (id: string) => void): void;
  /** Called after the owner ends sign-ins made with the shared cookie, so sockets opened with it can close. */
  onEndLegacy(fn: () => void): void;
  /** True until the owner ends older sign-ins for the current token. */
  legacyAllowed(): boolean;
  endLegacy(): void;
}

const NAME_MAX = 60;
const MAX_DEVICES = 100;
const TOUCH_EVERY_MS = 60_000;
const ADOPT_WINDOW_MS = 10_000;
const LEGACY_KEY = 'access.legacy_ended_for';

/** A short device name from a User-Agent string. Best effort; the owner can rename it. */
export function deviceNameFromUserAgent(ua: string | undefined): string {
  if (!ua) return 'Unknown device';
  let os: string | null = null;
  if (/iPhone/.test(ua)) os = 'iPhone';
  else if (/iPad/.test(ua)) os = 'iPad';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/Windows/.test(ua)) os = 'Windows';
  else if (/Macintosh|Mac OS X/.test(ua)) os = 'Mac';
  else if (/CrOS/.test(ua)) os = 'Chromebook';
  else if (/Linux|X11/.test(ua)) os = 'Linux';
  if (!os) return 'Unknown device';
  let browser: string | null = null;
  if (/Edg(e|A|iOS)?\//.test(ua)) browser = 'Edge';
  else if (/OPR\/|Opera/.test(ua)) browser = 'Opera';
  else if (/Firefox\/|FxiOS\//.test(ua)) browser = 'Firefox';
  else if (/Chrome\/|CriOS\//.test(ua)) browser = 'Chrome';
  else if (/Safari\//.test(ua)) browser = 'Safari';
  return browser ? `${os} (${browser})` : os;
}

const ADDR_SHAPE = /^[0-9a-fA-F:.]{2,45}$/;

/**
 * Who the peer is, for display. `forwardedFor` (the nearest proxy's X-Forwarded-For entry) is
 * believed only when the peer is a proxy on this machine: loopback, or WSL's gateway. From any
 * other peer the header is whatever the client sent.
 */
export function describePeer(
  remoteAddress: string | undefined,
  forwardedFor: string | undefined,
  isGatewayPeer: (a: string | undefined) => boolean,
): Peer {
  const addr = remoteAddress?.replace(/^::ffff:/, '') ?? '';
  if (!addr) return { addr: 'unknown', kind: 'direct' };
  const loop = isLoopbackAddress(remoteAddress);
  const gw = !loop && isGatewayPeer(remoteAddress);
  if ((loop || gw) && forwardedFor && ADDR_SHAPE.test(forwardedFor.trim())) {
    return { addr: forwardedFor.trim().replace(/^::ffff:/, ''), kind: 'forwarded' };
  }
  return { addr, kind: loop ? 'local' : gw ? 'gateway' : 'direct' };
}

interface Row {
  id: string; name: string; user_agent: string | null; signed_in_via: SignInMethod;
  created_at: number; last_seen_at: number; last_address: string | null; address_kind: AddressKind | null;
  token_fp: string;
}
const toInfo = (r: Row): DeviceInfo => ({
  id: r.id, name: r.name, signedInVia: r.signed_in_via, createdAt: r.created_at, lastSeenAt: r.last_seen_at,
  lastAddress: r.last_address, addressKind: r.address_kind,
});
const cleanName = (n: string) => n.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, NAME_MAX).trim();

export function createDeviceStore(
  db: Database.Database,
  opts: { getToken: () => string; now?: () => number },
): DeviceStore {
  const now = opts.now ?? Date.now;
  const listeners: ((id: string) => void)[] = [];
  const legacyListeners: (() => void)[] = [];
  const lastWrite = new Map<string, number>();
  const adopted = new Map<string, { id: string; until: number }>();
  const fp = () => tokenFingerprint(opts.getToken());

  /** Forget these ids and tell the listeners, so a row that goes away never leaves a socket open. */
  const forget = (ids: string[]) => {
    for (const id of ids) {
      lastWrite.delete(id);
      for (const [k, v] of adopted) if (v.id === id) adopted.delete(k);
      for (const fn of listeners) { try { fn(id); } catch { /* a listener must not break a revoke */ } }
    }
  };
  const dropStale = () => {
    const ids = (db.prepare('SELECT id FROM devices WHERE token_fp != ?').all(fp()) as { id: string }[]).map((r) => r.id);
    if (!ids.length) return;
    db.prepare('DELETE FROM devices WHERE token_fp != ?').run(fp());
    forget(ids);
  };
  const insert = (userAgent: string | undefined, via: SignInMethod, peer: Peer): DeviceInfo => {
    dropStale();
    const t = now();
    const row: Row = {
      id: crypto.randomBytes(16).toString('base64url'),
      name: deviceNameFromUserAgent(userAgent), user_agent: (userAgent ?? '').slice(0, 300) || null,
      signed_in_via: via, created_at: t, last_seen_at: t, last_address: peer.addr, address_kind: peer.kind, token_fp: fp(),
    };
    db.prepare(`INSERT INTO devices (id, name, user_agent, signed_in_via, created_at, last_seen_at, last_address, address_kind, token_fp)
      VALUES (@id, @name, @user_agent, @signed_in_via, @created_at, @last_seen_at, @last_address, @address_kind, @token_fp)`).run(row);
    // Keep the table bounded: a signed-in caller can sign in again and again.
    const over = (db.prepare('SELECT id FROM devices ORDER BY last_seen_at DESC, created_at DESC LIMIT -1 OFFSET ?').all(MAX_DEVICES) as { id: string }[]).map((r) => r.id);
    if (over.length) {
      const del = db.prepare('DELETE FROM devices WHERE id = ?');
      for (const id of over) del.run(id);
      forget(over);
    }
    lastWrite.set(row.id, t);
    return toInfo(row);
  };

  return {
    create: ({ userAgent, via, peer }) => insert(userAgent, via, peer),

    adoptLegacy(userAgent, peer) {
      const key = `${userAgent ?? ''}|${peer.addr}`;
      const t = now();
      const hit = adopted.get(key);
      if (hit && hit.until > t) {
        const r = db.prepare('SELECT * FROM devices WHERE id = ?').get(hit.id) as Row | undefined;
        if (r) return toInfo(r);
      }
      if (adopted.size > 200) adopted.clear();
      const d = insert(userAgent, 'earlier', peer);
      adopted.set(key, { id: d.id, until: t + ADOPT_WINDOW_MS });
      return d;
    },

    verify(cookie) {
      const parsed = parseDeviceCookie(cookie);
      if (!parsed) return null;
      const expected = parseDeviceCookie(deviceCookieValue(opts.getToken(), parsed.id));
      if (!expected || !tokenMatches(expected.mac, parsed.mac)) return null;
      const r = db.prepare('SELECT token_fp FROM devices WHERE id = ?').get(parsed.id) as { token_fp: string } | undefined;
      return r && r.token_fp === fp() ? { id: parsed.id } : null;
    },

    touch(id, peer, userAgent) {
      const t = now();
      const last = lastWrite.get(id);
      if (last !== undefined && t - last < TOUCH_EVERY_MS) return;
      if (lastWrite.size > 1000) lastWrite.clear();
      lastWrite.set(id, t);
      db.prepare('UPDATE devices SET last_seen_at = ?, last_address = ?, address_kind = ?, user_agent = COALESCE(?, user_agent) WHERE id = ?')
        .run(t, peer.addr, peer.kind, userAgent ? userAgent.slice(0, 300) : null, id);
    },

    list() {
      dropStale();
      return (db.prepare('SELECT * FROM devices ORDER BY last_seen_at DESC, created_at DESC').all() as Row[]).map(toInfo);
    },

    rename(id, name) {
      const n = cleanName(name);
      if (!n) return false;
      return db.prepare('UPDATE devices SET name = ? WHERE id = ?').run(n, id).changes > 0;
    },

    revoke(id) {
      const gone = db.prepare('DELETE FROM devices WHERE id = ?').run(id).changes > 0;
      if (gone) forget([id]);
      return gone;
    },

    onRevoke(fn) { listeners.push(fn); },
    onEndLegacy(fn) { legacyListeners.push(fn); },

    legacyAllowed() {
      const r = db.prepare('SELECT value FROM app_state WHERE key = ?').get(LEGACY_KEY) as { value: string } | undefined;
      return r?.value !== fp();
    },

    endLegacy() {
      db.prepare('INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(LEGACY_KEY, fp());
      for (const fn of legacyListeners) { try { fn(); } catch { /* ignore */ } }
    },
  };
}
