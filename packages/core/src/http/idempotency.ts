/**
 * An in-memory record of answered requests, by `Idempotency-Key` (engineering program W1-D).
 *
 * A client that could not read the answer to a POST sends the POST again with the same key. The
 * route then returns the first answer and does the work once. The scope keeps the keys of one
 * resource apart from the keys of another (the message route uses the terminal id).
 *
 * The record does not survive a daemon restart. The journal of W3-D makes it durable.
 */

export interface CachedResponse {
  status: number;
  body?: unknown;
}

export interface IdempotencyCache {
  /** The first response for this key, or null when there is none (or it expired). */
  seen(scope: string, key: string): CachedResponse | null;
  /** Keep the response of a request that did its work. Ends the flight. The first response for a key wins. */
  remember(scope: string, key: string, r: CachedResponse): void;
  /** Mark the request as in flight. False when the key is in flight now or has a response already. */
  begin(scope: string, key: string): boolean;
  /** End a flight with no response kept: the request failed and did no work, so the same key may run again. */
  release(scope: string, key: string): void;
  /** The number of scopes that hold a key (for tests and diagnostics). */
  scopes(): number;
}

interface Scope {
  /** In insertion order, which is also time order: the oldest key is first. */
  done: Map<string, { r: CachedResponse; at: number }>;
  flying: Map<string, number>;
}

export const IDEMPOTENCY_TTL_MS = 10 * 60_000;
export const IDEMPOTENCY_MAX_KEYS = 500;

export function createIdempotencyCache(opts: { ttlMs?: number; max?: number; now?: () => number } = {}): IdempotencyCache {
  const ttlMs = opts.ttlMs ?? IDEMPOTENCY_TTL_MS;
  const max = opts.max ?? IDEMPOTENCY_MAX_KEYS;
  const now = opts.now ?? Date.now;
  const byScope = new Map<string, Scope>();

  /** Drop what expired in one scope; drop the scope when nothing is left. */
  const prune = (name: string, scope: Scope, at: number): void => {
    for (const [key, entry] of scope.done) {
      if (at - entry.at <= ttlMs) break; // time order: the rest is newer
      scope.done.delete(key);
    }
    for (const [key, started] of scope.flying) if (at - started > ttlMs) scope.flying.delete(key);
    if (!scope.done.size && !scope.flying.size) byScope.delete(name);
  };
  const sweep = (at: number): void => { for (const [name, scope] of byScope) prune(name, scope, at); };
  const scopeFor = (name: string): Scope => {
    let scope = byScope.get(name);
    if (!scope) { scope = { done: new Map(), flying: new Map() }; byScope.set(name, scope); }
    return scope;
  };

  return {
    seen(scope, key) {
      const s = byScope.get(scope);
      if (!s) return null;
      prune(scope, s, now());
      return s.done.get(key)?.r ?? null;
    },
    remember(scope, key, r) {
      const at = now();
      sweep(at);
      const s = scopeFor(scope);
      s.flying.delete(key);
      if (s.done.has(key)) return;
      s.done.set(key, { r, at });
      while (s.done.size > max) s.done.delete(s.done.keys().next().value as string);
    },
    begin(scope, key) {
      const at = now();
      sweep(at);
      const s = scopeFor(scope);
      if (s.done.has(key) || s.flying.has(key)) return false;
      s.flying.set(key, at);
      // A flood of keys that never finish must not grow without limit either.
      while (s.flying.size > max) s.flying.delete(s.flying.keys().next().value as string);
      return true;
    },
    release(scope, key) {
      const s = byScope.get(scope);
      if (!s) return;
      s.flying.delete(key);
      if (!s.done.size && !s.flying.size) byScope.delete(scope);
    },
    scopes: () => byScope.size,
  };
}
