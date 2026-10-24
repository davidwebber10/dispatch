const KEY_RE = /(dtk|dck|dsk)_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g;

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

/** Longest partial key that can sit at the end of a chunk (a key is 47 characters). */
const KEY_TAIL = 46;

/**
 * Redacts keys in a stream of text chunks. It holds the last 46 characters back
 * until the next chunk (or `end()`), so a key split across two chunks is still found.
 */
export class KeyStreamRedactor {
  private held = '';

  /** Add a chunk; returns the text that is now safe to write. */
  push(chunk: string): string {
    const redacted = redactKeys(this.held + chunk);
    if (redacted.length <= KEY_TAIL) {
      this.held = redacted;
      return '';
    }
    let cut = redacted.length - KEY_TAIL;
    const c = redacted.charCodeAt(cut);
    if (c >= 0xdc00 && c <= 0xdfff) cut -= 1; // do not split a surrogate pair
    this.held = redacted.slice(cut);
    return redacted.slice(0, cut);
  }

  /** Flush the held tail (call at the end of the stream or on error). */
  end(): string {
    const out = redactKeys(this.held);
    this.held = '';
    return out;
  }
}
