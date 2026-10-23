import crypto from 'node:crypto';

/**
 * In-memory registry of per-process keys. Only sha256 hashes are held, so a heap dump or an
 * inspect of the registry does not show a usable key.
 */
export type KeyKind = 'thread' | 'chat' | 'shell';
export const KEY_PREFIX: Record<KeyKind, 'dtk_' | 'dck_' | 'dsk_'> = {
  thread: 'dtk_',
  chat: 'dck_',
  shell: 'dsk_',
};
export type ChatStartedBy = 'user' | 'report' | 'summarizer';
declare const handleBrand: unique symbol;
export type KeyHandle = string & { readonly [handleBrand]: true };
export type KeyPrincipal =
  | { kind: 'thread'; terminalId: string; handle: KeyHandle }
  | { kind: 'shell'; terminalId: string; handle: KeyHandle }
  | { kind: 'chat'; startedBy: ChatStartedBy; handle: KeyHandle };
export type MintInput =
  | { kind: 'thread'; terminalId: string }
  | { kind: 'shell'; terminalId: string }
  | { kind: 'chat'; startedBy: ChatStartedBy };

const BODY = /^[A-Za-z0-9_-]{43}$/;
const hash = (k: string) => crypto.createHash('sha256').update(k).digest('hex');

/** The kind of a key literal: exact prefix and 43 base64url characters, else null. */
export function keyKindOf(value: string): KeyKind | null {
  for (const kind of ['thread', 'chat', 'shell'] as const) {
    const p = KEY_PREFIX[kind];
    if (value.startsWith(p) && BODY.test(value.slice(p.length))) return kind;
  }
  return null;
}

/**
 * The key-shaped Bearer value of an Authorization header, else null. A value that starts with a
 * key prefix counts even when malformed, so a bad key is refused instead of falling back to
 * another credential. Any other Bearer value is ignored (an older CLI may send a literal
 * placeholder).
 */
export function bearerKey(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
  if (!m) return null;
  const v = m[1];
  return Object.values(KEY_PREFIX).some((p) => v.startsWith(p)) ? v : null;
}

export class KeyRegistry {
  private byHash = new Map<string, KeyPrincipal>();
  private hashByHandle = new Map<KeyHandle, string>();
  private liveByTerminal = new Map<string, KeyHandle>();

  /** Thread and shell keys: a new key revokes the terminal's previous one. */
  mint(input: MintInput): { key: string; handle: KeyHandle } {
    const key = KEY_PREFIX[input.kind] + crypto.randomBytes(32).toString('base64url');
    const handle = crypto.randomUUID() as KeyHandle;
    if (input.kind !== 'chat') {
      const old = this.liveByTerminal.get(input.terminalId);
      if (old) this.revoke(old);
      this.liveByTerminal.set(input.terminalId, handle);
    }
    const h = hash(key);
    this.byHash.set(h, { ...input, handle } as KeyPrincipal);
    this.hashByHandle.set(handle, h);
    return { key, handle };
  }

  /** Unknown, revoked and malformed values give null. */
  resolve(key: string): KeyPrincipal | null {
    if (typeof key !== 'string' || !keyKindOf(key)) return null;
    return this.byHash.get(hash(key)) ?? null;
  }

  /** Idempotent. */
  revoke(handle: KeyHandle): void {
    const h = this.hashByHandle.get(handle);
    if (h === undefined) return;
    const p = this.byHash.get(h);
    this.byHash.delete(h);
    this.hashByHandle.delete(handle);
    if (p && p.kind !== 'chat' && this.liveByTerminal.get(p.terminalId) === handle) {
      this.liveByTerminal.delete(p.terminalId);
    }
  }

  liveHandleFor(terminalId: string): KeyHandle | undefined {
    return this.liveByTerminal.get(terminalId);
  }

  size(): number {
    return this.byHash.size;
  }
}
