/**
 * Finds sign-in URLs in terminal output.
 *
 * WHY this exists: the `$BROWSER` shim (shim.ts) only fires when a CLI actually *execs* a
 * browser. Many do not. Device-code grants — `gh auth login --web` was measured doing exactly
 * this, see commit 2823ecb — simply PRINT a URL and poll in the background. Nothing is
 * exec'd, so nothing was ever relayed to the operator. Reading the output covers that case.
 *
 * The bar for reporting is deliberately high. A false positive puts a modal-ish banner in
 * front of the user for an ordinary link, which is worse than missing one: so a URL must be
 * https, must not be loopback, and must carry an unmistakable sign-in signal.
 */

/** Escape codes the PTY interleaves with the text. Mirrors terminal-monitor.ts. */
const ANSI = /\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b\([A-Za-z]/g;

/**
 * Characters allowed to continue a URL: printable ASCII only, minus whitespace, quotes and
 * brackets. Restricting to ASCII matters — a URL rendered inside a box-drawn TUI panel, or
 * followed by an arrow in prose, otherwise swallows those glyphs and percent-encodes them
 * into the captured URL (observed: `…/oauth2/device?user_cod%E2%94%80%E2%94%` from `──`).
 */
const URL_RE = /https?:\/\/[^\s"'`<>()\[\]{}\\^|\x7f-\uffff]+/g;

/**
 * Substrings that mark a URL as a sign-in URL rather than a link the agent happened to
 * print. Matched case-insensitively against the whole URL.
 */
const AUTH_SIGNALS = [
  'oauth', 'authorize', 'auth/', 'auth.', '/auth', 'login', 'signin', 'sign-in', 'sign_in',
  'device', 'verify', 'activate', 'user_code', 'usercode', 'sso', 'connect/token',
];

/** Trailing characters prose adds that are never part of the URL. */
const TRAILING = /[.,;:!?)>\]}'"]+$/;

/**
 * A dangling percent-escape at the very end. `%` is legal mid-URL (that is what
 * percent-encoding is), but an escape needs two hex digits after it — so a trailing `%` or
 * `%A` is not part of the URL. In practice this is zsh's end-of-partial-line marker printed
 * straight after the URL, which was being absorbed into it.
 */
const DANGLING_ESCAPE = /%[0-9A-Fa-f]?$/;

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

/** Per-terminal rolling window. Big enough for a wrapped URL plus context, small enough to ignore. */
const MAX_BUFFER = 4096;
/** Distinct URLs one terminal may ever report. A sprayer must not queue endless banners. */
const MAX_REPORTED_PER_TERMINAL = 10;

export function looksLikeAuthUrl(raw: string): boolean {
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  // https only: an http sign-in page on the open internet is not something to hand a user,
  // and http is overwhelmingly a local dev server.
  if (url.protocol !== 'https:') return false;
  if (LOOPBACK.has(url.hostname)) return false;
  const hay = raw.toLowerCase();
  return AUTH_SIGNALS.some((s) => hay.includes(s));
}

function clean(candidate: string): string {
  return candidate.replace(TRAILING, '').replace(DANGLING_ESCAPE, '');
}

/**
 * True when this URL sits at the very end of the text, i.e. it may still be arriving.
 * Reporting then risks a truncated URL — and then a second banner when the rest lands.
 */
function stillStreaming(text: string, url: string): boolean {
  const stripped = text.replace(ANSI, '');
  return stripped.endsWith(url) || unwrap(stripped).endsWith(url);
}

/**
 * The shortest line that could plausibly have been hard-wrapped. A terminal only breaks a
 * line when it reaches its width, and no real terminal is narrower than this — so a short
 * line ending in a newline is a genuine line break, not a wrap.
 *
 * Without this bound the rejoin glues a URL to whatever prose followed it:
 * `…/login/device\nEnter code` becomes `…/login/deviceEnter`, a URL that 404s.
 */
const MIN_WRAP_LINE = 60;

/**
 * Rejoin a URL the terminal hard-wrapped. At the column boundary the PTY inserts a newline
 * with no surrounding space, so a wrap is a break between two non-space characters on a line
 * long enough to have hit the edge. Same class of bug as the wrapped login token in commit
 * 0138bf0.
 */
function unwrap(text: string): string {
  const lines = text.replace(/\r/g, '').split('\n');
  let out = lines[0] ?? '';
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1];
    const cur = lines[i];
    const wrapped =
      prev.length >= MIN_WRAP_LINE &&
      !/\s$/.test(prev) &&
      cur !== '' &&
      !/^\s/.test(cur);
    out += wrapped ? cur : `\n${cur}`;
  }
  return out;
}

/**
 * Every sign-in URL in a block of terminal output.
 *
 * Scans the text both as-written and with wraps rejoined, because the rejoin can also glue a
 * URL to whatever followed it. Taking both and dropping any candidate that is a strict prefix
 * of another keeps the complete URL and discards the truncated fragment.
 */
export function extractAuthUrls(text: string): string[] {
  const stripped = text.replace(ANSI, '');
  const candidates = new Set<string>();
  for (const variant of [stripped, unwrap(stripped)]) {
    for (const m of variant.matchAll(URL_RE)) {
      const url = clean(m[0]);
      if (looksLikeAuthUrl(url)) candidates.add(url);
    }
  }
  const all = [...candidates];
  // Drop fragments: "…&sta" is a prefix of "…&state=xyz", so only the full URL survives.
  return all.filter((u) => !all.some((other) => other !== u && other.startsWith(u)));
}

/**
 * Stateful scanner over a terminal's output stream.
 *
 * Holds a small rolling buffer per terminal so a URL split across two PTY chunks is still
 * found, and remembers what it has already reported so a CLI that reprints "waiting for
 * sign-in… <url>" every second raises exactly one banner.
 */
export class AuthUrlScanner {
  private buffers = new Map<string, string>();
  private reported = new Map<string, Set<string>>();

  /** Feed one chunk of output. Returns any sign-in URLs not yet reported for this terminal. */
  feed(terminalId: string, chunk: string): string[] {
    const buffer = ((this.buffers.get(terminalId) ?? '') + chunk).slice(-MAX_BUFFER);
    this.buffers.set(terminalId, buffer);

    let seen = this.reported.get(terminalId);
    if (!seen) { seen = new Set(); this.reported.set(terminalId, seen); }
    if (seen.size >= MAX_REPORTED_PER_TERMINAL) return [];

    const fresh: string[] = [];
    for (const url of extractAuthUrls(buffer)) {
      if (seen.has(url)) continue;
      // A URL still arriving in pieces would be reported truncated, then again in full. Wait
      // until the buffer shows something after it — a newline, a space, or more output.
      if (stillStreaming(buffer, url)) continue;
      seen.add(url);
      fresh.push(url);
      if (seen.size >= MAX_REPORTED_PER_TERMINAL) break;
    }
    return fresh;
  }

  /** Drop a terminal's state — on close, or on relaunch so a re-login relays again. */
  forget(terminalId: string): void {
    this.buffers.delete(terminalId);
    this.reported.delete(terminalId);
  }

  /** Test seam: the rolling buffer must stay bounded on a chatty terminal. */
  bufferSize(terminalId: string): number {
    return (this.buffers.get(terminalId) ?? '').length;
  }
}
