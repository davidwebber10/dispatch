// packages/core/src/http/canonical-path.ts
// One spelling per route.
//
// Every check that decides from a request path (the route table, the profile gate, the key rules, the
// WebSocket table) is only as good as the agreement between the string it reads and the string the
// router matches. So the daemon accepts exactly ONE spelling of a path and refuses every other one
// before anything routes:
//
//   - the framework matches case-sensitively and strictly (daemon/build.ts, auth/route-policy.ts);
//   - this file refuses (400) a path that is not in canonical form.
//
// Canonical form: starts with `/`; no empty segment (`//`); no `.` or `..` segment; no backslash, no
// control character, no raw non-ASCII byte, no `;` path parameter; every `%` is a valid escape; no
// escape that hides a path character (`%2f`, `%5c`, `%2e`, `%00`…`%1f`, `%7f`, `%3b`) and no escape of a
// character that needs none (a letter, a digit, `-`, `_`, `~`): such a path would change under one
// round of decoding; the decoded path is not itself still encoded (double encoding); `/api` is written
// in lower case; an `/api`, `/plugins`, `/icons` or `/assets` path has no trailing slash.
//
// One exception, on purpose: what follows `/api/plugins/<id>/worker/` is the path of a request to that
// plugin's own worker (routes/plugins.ts forwards it byte for byte), so its escapes are the worker's
// business. The part before it is checked like every path, and the tail still may not hold an empty
// or a dot segment, a backslash, a control character or a broken escape.
//
// It applies to every install, local ones included: no client of Dispatch sends such a path.
import type { IncomingMessage } from 'node:http';
import type { RequestHandler } from 'express';

/** Why a path is refused, or null when it is canonical. The reason is for logs and tests, never a secret. */
export type PathProblem =
  | 'not_absolute' | 'empty_segment' | 'dot_segment' | 'forbidden_character' | 'bad_escape'
  | 'encoded_separator' | 'needless_escape' | 'double_encoded' | 'prefix_case' | 'trailing_slash';

/** Escapes that stand for a character with a meaning in a path: `/ \ . ;`, NUL, the control characters and DEL. */
const HIDDEN_CHAR = /%(?:2f|5c|2e|3b|7f|[01][0-9a-f])/i;
/** Escapes of a character that is written as itself in a path: `a-z A-Z 0-9 - _ ~` (`.` is in HIDDEN_CHAR). */
const NEEDLESS = /%(?:3[0-9]|4[1-9a-f]|5[0-9a]|6[1-9a-f]|7[0-9a]|2d|5f|7e)/i;
/** Prefixes whose routes are matched by exact spelling: no trailing slash, lower case only. */
const EXACT_PREFIXES = ['api', 'plugins', 'icons', 'assets'];

/** `/api/plugins/<id>/worker` followed by `/`: the head is a route of the daemon, the rest belongs to the worker. */
const WORKER_HEAD = /^(\/api\/plugins\/[^/]+\/worker)(\/.*)$/;

/** The looser check of a worker tail (it starts with `/`). */
function workerTailProblem(tail: string): PathProblem | null {
  if (/[^\x21-\x7e]|[\\#]/.test(tail)) return 'forbidden_character';
  if (/%(?![0-9a-f]{2})/i.test(tail)) return 'bad_escape';
  if (/%(?:7f|[01][0-9a-f])/i.test(tail)) return 'encoded_separator';
  const segments = tail.split('/').slice(1);
  if (segments.slice(0, -1).some((s) => s === '')) return 'empty_segment';
  if (segments.some((s) => s === '.' || s === '..')) return 'dot_segment';
  return null;
}

/**
 * Check the path part of a request target (`/a/b?x=1` → `/a/b`). The query string is not a path: it is
 * left to the handlers, which read it as data.
 */
export function canonicalPathProblem(target: string): PathProblem | null {
  const q = target.indexOf('?');
  const whole = q === -1 ? target : target.slice(0, q);
  const worker = WORKER_HEAD.exec(whole);
  if (worker) return canonicalPathProblem(worker[1]) ?? workerTailProblem(worker[2]);
  const p = whole;
  if (!p.startsWith('/')) return 'not_absolute';
  // Printable ASCII only; no backslash (a separator on some systems), no `;` (a path parameter that
  // other servers strip), no `#`.
  if (/[^\x21-\x7e]|[\\;#]/.test(p)) return 'forbidden_character';
  if (/%(?![0-9a-f]{2})/i.test(p)) return 'bad_escape';
  if (HIDDEN_CHAR.test(p)) return 'encoded_separator';
  if (NEEDLESS.test(p)) return 'needless_escape';
  const segments = p.split('/').slice(1);
  if (p !== '/' && segments.slice(0, -1).some((s) => s === '')) return 'empty_segment';
  if (segments.some((s) => s === '.' || s === '..')) return 'dot_segment';
  let decoded: string;
  try { decoded = decodeURIComponent(p); } catch { return 'bad_escape'; }
  // One round of decoding must end the encoding: `%252f` decodes to `%2f`, which a second decoder
  // somewhere would turn into a separator.
  if (/%[0-9a-f]{2}/i.test(decoded)) return 'double_encoded';
  if (/[\x00-\x1f\x7f\\]/.test(decoded)) return 'forbidden_character';
  const first = segments[0] ?? '';
  const lower = first.toLowerCase();
  if (EXACT_PREFIXES.includes(lower)) {
    if (first !== lower) return 'prefix_case';
    if (p.length > 1 && p.endsWith('/')) return 'trailing_slash';
  }
  return null;
}

/** The body of the refusal. It says nothing about which routes exist. */
export const BAD_PATH_BODY = { error: 'bad_path', message: 'The request path is not in canonical form.' } as const;

/**
 * The middleware. Mount it after the base-path strip and before everything that reads the path: the
 * gates, the principal check, the routes and the static files.
 */
export const requireCanonicalPath: RequestHandler = (req, res, next) => {
  if (canonicalPathProblem(req.url) === null) return next();
  res.status(400).json(BAD_PATH_BODY);
};

/** The same check for a WebSocket upgrade (Express middleware never runs for one). `url`: prefix already stripped. */
export function upgradePathIsCanonical(url: string, _request?: IncomingMessage): boolean {
  return canonicalPathProblem(url) === null;
}
