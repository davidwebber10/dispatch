import crypto from 'node:crypto';

/**
 * Pairing codes (network exposure spec, 8.1, first slice): a short, one-time secret the owner
 * makes in Settings → Access and types, or scans as a QR link, on another device's sign-in page.
 * It stands in for the raw token on `POST /api/access/login`, so the token itself never has to
 * leave this computer or be read over the API.
 *
 * Shape: 8 characters from an alphabet without 0/O/1/I, shown as XXXX-XXXX. That is 40 bits.
 * With the login route's 10 failures a minute per caller and a 5-minute life, a guess has no
 * real chance. One code is live at a time: a new one replaces the old. A code is consumed on
 * its first successful use, whether or not the cookie that follows is kept.
 */
export const PAIR_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const PAIR_CODE_LENGTH = 8;
export const PAIR_CODE_TTL_MS = 5 * 60_000;

export interface PairCodes {
  /** Make a new code; it replaces any live one. */
  issue(): { code: string; expiresAt: number };
  /** Consume the live code if `given` matches it (case, dashes and spaces ignored) and it is not expired. */
  redeem(given: string): boolean;
  /** True while a code is live (for the UI's status line; never returns the code). */
  active(): boolean;
}

/** Upper-case the letters and drop separators, so `abcd-efgh` and `ABCD EFGH` both match. */
export function normalizePairCode(given: string): string {
  return given.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Shown form: XXXX-XXXX. */
export function formatPairCode(raw: string): string {
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/** True when a sign-in value has the shape of a code rather than a token (8 alphabet characters). */
export function looksLikePairCode(given: string): boolean {
  const n = normalizePairCode(given);
  return n.length === PAIR_CODE_LENGTH && [...n].every((c) => PAIR_CODE_ALPHABET.includes(c));
}

export function createPairCodes(opts: { now?: () => number; ttlMs?: number } = {}): PairCodes {
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? PAIR_CODE_TTL_MS;
  let live: { raw: string; expiresAt: number } | null = null;
  const expired = () => !live || now() >= live.expiresAt;
  return {
    issue() {
      const bytes = crypto.randomBytes(PAIR_CODE_LENGTH);
      let raw = '';
      for (let i = 0; i < PAIR_CODE_LENGTH; i++) raw += PAIR_CODE_ALPHABET[bytes[i] % PAIR_CODE_ALPHABET.length];
      live = { raw, expiresAt: now() + ttl };
      return { code: formatPairCode(raw), expiresAt: live.expiresAt };
    },
    redeem(given) {
      if (expired()) { live = null; return false; }
      const n = normalizePairCode(given);
      const a = Buffer.from(n);
      const b = Buffer.from(live!.raw);
      const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
      if (ok) live = null; // one use
      return ok;
    },
    active: () => !expired(),
  };
}
