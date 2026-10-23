import { describe, it, expect } from 'vitest';
import util from 'node:util';
import { KeyRegistry, keyKindOf, KEY_PREFIX } from './principals.js';

describe('KeyRegistry', () => {
  it('mints a thread key and resolves it', () => {
    const r = new KeyRegistry();
    const { key, handle } = r.mint({ kind: 'thread', terminalId: 't1' });
    expect(key).toMatch(/^dtk_[A-Za-z0-9_-]{43}$/);
    expect(r.resolve(key)).toEqual({ kind: 'thread', terminalId: 't1', handle });
  });

  it('mints chat and shell keys with their prefixes', () => {
    const r = new KeyRegistry();
    const c = r.mint({ kind: 'chat', startedBy: 'report' });
    const s = r.mint({ kind: 'shell', terminalId: 's1' });
    expect(c.key).toMatch(/^dck_[A-Za-z0-9_-]{43}$/);
    expect(s.key).toMatch(/^dsk_[A-Za-z0-9_-]{43}$/);
    expect(r.resolve(c.key)).toEqual({ kind: 'chat', startedBy: 'report', handle: c.handle });
    expect(r.resolve(s.key)).toMatchObject({ kind: 'shell', terminalId: 's1' });
  });

  it('keeps several chat keys live at once', () => {
    const r = new KeyRegistry();
    const a = r.mint({ kind: 'chat', startedBy: 'user' });
    const b = r.mint({ kind: 'chat', startedBy: 'user' });
    expect(r.resolve(a.key)).not.toBeNull();
    expect(r.resolve(b.key)).not.toBeNull();
  });

  it('a second mint for a terminal revokes the first key', () => {
    const r = new KeyRegistry();
    const a = r.mint({ kind: 'thread', terminalId: 't1' });
    const b = r.mint({ kind: 'thread', terminalId: 't1' });
    expect(r.resolve(a.key)).toBeNull();
    expect(r.resolve(b.key)).not.toBeNull();
    expect(r.liveHandleFor('t1')).toBe(b.handle);
  });

  it('revoke is idempotent and an old handle leaves the new key alone', () => {
    const r = new KeyRegistry();
    const a = r.mint({ kind: 'thread', terminalId: 't1' });
    r.revoke(a.handle);
    expect(r.resolve(a.key)).toBeNull();
    expect(() => r.revoke(a.handle)).not.toThrow();
    const b = r.mint({ kind: 'thread', terminalId: 't1' });
    r.revoke(a.handle);
    expect(r.resolve(b.key)).not.toBeNull();
    expect(r.liveHandleFor('t1')).toBe(b.handle);
    r.revoke(b.handle);
    expect(r.liveHandleFor('t1')).toBeUndefined();
    expect(r.size()).toBe(0);
  });

  it('resolve returns null for unknown or malformed values', () => {
    const r = new KeyRegistry();
    const { key } = r.mint({ kind: 'thread', terminalId: 't1' });
    expect(r.resolve('dtk_' + 'A'.repeat(43))).toBeNull();
    expect(r.resolve('')).toBeNull();
    expect(r.resolve('dtk_short')).toBeNull();
    expect(r.resolve('dck_' + key.slice(4))).toBeNull();
    expect(r.resolve(key + 'A')).toBeNull();
  });

  it('holds hashes only', () => {
    const r = new KeyRegistry();
    const { key } = r.mint({ kind: 'thread', terminalId: 't1' });
    expect(util.inspect(r, { depth: 5 })).not.toContain(key);
    expect(util.inspect(r, { depth: 5 })).not.toContain(key.slice(4));
  });
});

describe('keyKindOf', () => {
  it('detects each kind', () => {
    const body = 'A'.repeat(43);
    expect(keyKindOf(KEY_PREFIX.thread + body)).toBe('thread');
    expect(keyKindOf(KEY_PREFIX.chat + body)).toBe('chat');
    expect(keyKindOf(KEY_PREFIX.shell + body)).toBe('shell');
  });
  it('returns null for everything else', () => {
    expect(keyKindOf('Bearer x')).toBeNull();
    expect(keyKindOf('a'.repeat(64))).toBeNull();
    expect(keyKindOf('dtk_')).toBeNull();
  });
});
