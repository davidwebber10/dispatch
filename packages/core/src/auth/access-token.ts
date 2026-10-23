import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The Phase 1 access token (network exposure spec, 7.5).
 *
 * One random secret in `<dataDir>/access-token`, mode 0600. A browser that proves it knows the
 * token gets a cookie whose value is an HMAC of the token, so there is no session table and
 * rotating the token revokes every cookie at once.
 */
export const ACCESS_TOKEN_FILE = 'access-token';
export const COOKIE_NAME = 'dispatch_access';
/** 400 days, the longest a browser keeps a cookie. */
export const COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

const tokenPath = (dataDir: string) => path.join(dataDir, ACCESS_TOKEN_FILE);

export function readAccessToken(dataDir: string): string | null {
  try {
    const t = fs.readFileSync(tokenPath(dataDir), 'utf8').trim();
    return t || null;
  } catch {
    return null;
  }
}

function writeToken(dataDir: string): string {
  const token = crypto.randomBytes(32).toString('base64url');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  // Write to a 0600 temp file and rename, so the token is never readable by others, even briefly.
  const tmp = `${tokenPath(dataDir)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, token + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600); // a pre-existing tmp file would keep its old mode
  fs.renameSync(tmp, tokenPath(dataDir));
  return token;
}

/** Return the token, creating it on first use. */
export function ensureAccessToken(dataDir: string): string {
  return readAccessToken(dataDir) ?? writeToken(dataDir);
}

/** Write a new token. Every browser cookie made from the old one stops working. */
export function rotateAccessToken(dataDir: string): string {
  return writeToken(dataDir);
}

export function cookieValue(token: string): string {
  return crypto.createHmac('sha256', token).update('dispatch-access-cookie-v1').digest('base64url');
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const name = part.slice(0, i).trim();
    if (name && !(name in out)) out[name] = part.slice(i + 1).trim();
  }
  return out;
}

/** Current token, re-read when the file changes, so `dispatch access rotate` needs no restart. */
export function createTokenSource(dataDir: string): () => string {
  let mtime = -1;
  let token = ensureAccessToken(dataDir);
  return () => {
    try {
      const m = fs.statSync(tokenPath(dataDir)).mtimeMs;
      if (m !== mtime) { token = ensureAccessToken(dataDir); mtime = m; }
    } catch { token = ensureAccessToken(dataDir); }
    return token;
  };
}
