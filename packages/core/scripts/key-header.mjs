// The thread key header for the hook helpers (codex-notify.mjs, grok-hook.mjs).
//
// These scripts cannot import TypeScript, so this file repeats two rules of src/auth/credential.ts:
//   - which key to use (DISPATCH_AUTH, or the file in DISPATCH_AUTH_FILE), and
//   - the destination rule: a key is sent only to a URL under DISPATCH_API.
// tests/scripts/hook-helpers.test.ts runs both implementations over one table, so they cannot drift.
// Hooks send a dtk_ thread key only; a shell key, a Chat key or a bad value sends nothing (stage 1:
// the daemon counts a request with no credential and still serves it).

import fs from 'node:fs';

const THREAD_KEY = /^dtk_[A-Za-z0-9_-]{43}$/;
const SHELL_KEY = /^dsk_[A-Za-z0-9_-]{43}$/;

/** True only when DISPATCH_API is set and url is that origin and at or under its base path. */
export function keyAllowedFor(url, env = process.env) {
  const api = env.DISPATCH_API;
  if (!api) return false;
  let a;
  let u;
  try {
    a = new URL(api);
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (a.origin !== u.origin) return false;
  const base = a.pathname.replace(/\/+$/, '');
  return u.pathname === base || u.pathname.startsWith(base + '/');
}

function readKeyFile(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n')[0].trim();
  } catch {
    return '';
  }
}

/** The thread key of this process, or null. Never throws. */
export function threadKey(env = process.env) {
  const auth = env.DISPATCH_AUTH;
  if (auth && THREAD_KEY.test(auth)) return auth;
  if (auth && SHELL_KEY.test(auth)) return null; // a shell key is not a hook credential
  if (env.DISPATCH_AUTH_FILE) {
    const k = readKeyFile(env.DISPATCH_AUTH_FILE);
    return THREAD_KEY.test(k) ? k : null;
  }
  return null;
}

/** `{ authorization }` when the key may go to this url, else `{}`. */
export function authHeaders(url, env = process.env) {
  const key = threadKey(env);
  if (!key || !keyAllowedFor(url, env)) return {};
  return { authorization: `Bearer ${key}` };
}
