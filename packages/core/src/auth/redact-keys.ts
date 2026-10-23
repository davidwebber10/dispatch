const KEY_RE = /\b(dtk|dck|dsk)_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g;

/** Replace each per-thread key literal with its prefix and "[redacted]". */
export function redactKeys(text: string): string {
  return text.replace(KEY_RE, '$1_[redacted]');
}

/** Redact every string in arrays and plain objects. Returns new containers; other types pass through. */
export function redactKeysDeep<T>(value: T): T {
  if (typeof value === 'string') return redactKeys(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactKeysDeep(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactKeysDeep(v);
      return out as T;
    }
  }
  return value;
}
