import fs from 'fs';
import path from 'path';
import * as pty from 'node-pty';
import { v4 as uuid } from 'uuid';

/**
 * Headless Claude login for surfaces that have no terminal.
 *
 * The hosted OS surface deliberately exposes no terminal (see the OS design doc
 * §3.4), but every user still authenticates with their OWN Claude subscription.
 * That needs an interactive `claude` process somewhere — structured threads spawn
 * `claude -p …`, which is non-interactive and simply errors when unauthenticated.
 *
 * Why `claude setup-token` rather than driving the normal REPL login:
 *   • The REPL's first-run flow is a TUI wizard (theme picker, then login-method
 *     chooser) and it is NOT persisted first-run state — a box that has already
 *     been through it shows it again while unauthenticated. There is nothing to
 *     pre-seed, so the only alternative is puppeting a TUI with blind keystrokes,
 *     which breaks silently whenever the CLI's UI changes.
 *   • `setup-token`, combined with `forceLoginMethod: "claudeai"` in
 *     /etc/claude-code/managed-settings.json, goes straight to the OAuth URL with
 *     ZERO keystrokes and asks only for a short code to be pasted back.
 *
 * The resulting token is written 0600 into the daemon's own data dir and injected
 * as CLAUDE_CODE_OAUTH_TOKEN at spawn. It never leaves the box, which is what makes
 * it equivalent in risk to the `.credentials.json` a normal login would write.
 */

export type LoginStatus = 'starting' | 'awaiting_code' | 'exchanging' | 'complete' | 'error';

export interface LoginSession {
  id: string;
  status: LoginStatus;
  /** The OAuth URL to open in a browser. Present once status is awaiting_code. */
  url: string | null;
  error: string | null;
  createdAt: string;
}

/** Claude's OAuth tokens are `sk-ant-oat01-…`; captured from setup-token's output. */
const TOKEN_RE = /\b(sk-ant-oat[0-9]{2}-[A-Za-z0-9_-]+)\b/;
const URL_RE = /https:\/\/claude\.com\/[^\s"'\x07\x1b]+/;
const START_TIMEOUT_MS = 45_000;
const EXCHANGE_TIMEOUT_MS = 45_000;

/** Strip ANSI/OSC so regexes see plain text — setup-token emits hyperlink escapes. */
export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\][0-9;]*;[^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b[()][AB012]/g, '');
}

/**
 * Pull the OAuth URL out of raw terminal output, or null.
 *
 * Deliberately searches the RAW text rather than the stripped text. `setup-token`
 * emits the URL as an OSC-8 hyperlink: the *complete* URL is the escape sequence's
 * parameter, while the visible link text is wrapped and TRUNCATED to the terminal
 * width. Stripping escapes first throws away the only intact copy and leaves a
 * broken URL that fails silently when the user opens it.
 *
 * Both copies match, so take the longest.
 */
export function extractUrl(raw: string): string | null {
  const matches = raw.match(new RegExp(URL_RE.source, 'g'));
  if (!matches?.length) return null;
  return matches.reduce((longest, m) => (m.length > longest.length ? m : longest));
}

/**
 * Pull the minted OAuth token out of raw terminal output, or null.
 *
 * Defensively de-wraps first: even with a wide PTY, any line break the terminal
 * inserts inside the token would otherwise leave us matching a fragment. Tokens
 * contain no whitespace, so joining hard-wrapped lines cannot merge a token with
 * anything that legitimately follows it.
 */
export function extractToken(raw: string): string | null {
  const clean = stripAnsi(raw);
  const direct = clean.match(TOKEN_RE)?.[1] ?? null;
  const dewrapped = clean.replace(/\r?\n/g, '').match(TOKEN_RE)?.[1] ?? null;
  // Take the LONGER match, never the first: a wrapped token still yields a valid-
  // looking fragment from the un-joined text, and a length threshold would happily
  // accept it. (It did, on the first attempt at this fix.)
  if (direct && dewrapped) return dewrapped.length >= direct.length ? dewrapped : direct;
  return dewrapped ?? direct;
}

/** Last non-empty line of CLI output — the real reason when something fails. */
export function lastMeaningfulLine(raw: string): string | null {
  const lines = stripAnsi(raw)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^[\s\u2500-\u257F\u2800-\u28FF*·]+$/.test(l));
  return lines.length ? lines[lines.length - 1].slice(0, 200) : null;
}

interface Live {
  session: LoginSession;
  proc: pty.IPty;
  buf: string;
}

export class ClaudeLoginService {
  private live: Live | null = null;
  private onChangeCb: (() => void) | null = null;
  private readonly tokenPath: string;

  constructor(
    private readonly dataDir: string,
    private readonly spawnPty: typeof pty.spawn = pty.spawn,
  ) {
    this.tokenPath = path.join(dataDir, 'claude-oauth-token');
  }

  onChange(cb: () => void): void { this.onChangeCb = cb; }

  // --- token storage ------------------------------------------------------
  getToken(): string | null {
    try {
      const v = fs.readFileSync(this.tokenPath, 'utf8').trim();
      return v || null;
    } catch { return null; }
  }

  /** Env injected into spawned CLIs. Empty when the box isn't authenticated yet. */
  getSpawnEnv(): Record<string, string> {
    const token = this.getToken();
    return token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {};
  }

  isAuthenticated(): boolean { return this.getToken() !== null; }

  private saveToken(token: string): void {
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(this.tokenPath, token, { mode: 0o600 });
    try { fs.chmodSync(this.tokenPath, 0o600); } catch { /* best effort */ }
    this.onChangeCb?.();
  }

  /** Forget the stored token (sign out). */
  signOut(): void {
    try { fs.rmSync(this.tokenPath, { force: true }); } catch { /* ignore */ }
    this.onChangeCb?.();
  }

  // --- login flow ---------------------------------------------------------
  status(): LoginSession | null {
    return this.live ? { ...this.live.session } : null;
  }

  /**
   * Start `claude setup-token` and resolve once it has printed an OAuth URL.
   *
   * IDEMPOTENT. An attempt already waiting for a code is returned as-is rather
   * than destroyed. This flow necessarily involves the user LEAVING the page —
   * they open the URL, authorise, copy a code, come back — so a double-click, a
   * remount or a refresh in that window used to kill the in-flight login and
   * leave them submitting a code against a session that no longer existed.
   */
  async start(): Promise<LoginSession> {
    const pending = this.live;
    if (pending && pending.session.status === 'awaiting_code' && pending.session.url) {
      return { ...pending.session };
    }
    this.cancel();
    const session: LoginSession = {
      id: uuid(), status: 'starting', url: null, error: null,
      createdAt: new Date().toISOString(),
    };
    const proc = this.spawnPty('claude', ['setup-token'], {
      // Deliberately very wide. The minted token is ~100+ characters and a normal
      // 120-column terminal WRAPS it, inserting a newline mid-token — which is
      // exactly how the exchange silently "timed out": the token was printed, and
      // the pattern only ever matched the fragment before the wrap. Same class of
      // bug as the OAuth URL being truncated to the terminal width.
      name: 'xterm-256color', cols: 4000, rows: 40,
      cwd: this.dataDir,
      // Deliberately NOT inheriting an existing CLAUDE_CODE_OAUTH_TOKEN: re-authenticating
      // while a stale token is present makes the CLI skip the flow we're trying to run.
      env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: '' } as Record<string, string>,
    });
    const live: Live = { session, proc, buf: '' };
    this.live = live;

    proc.onData((d) => { live.buf += d; });
    proc.onExit(() => {
      if (this.live === live && live.session.status !== 'complete') {
        this.fail(live, 'claude setup-token exited before completing');
      }
    });

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const url = extractUrl(live.buf);
      if (url) {
        live.session.url = url;
        live.session.status = 'awaiting_code';
        return { ...live.session };
      }
      // Cast: the onExit handler can flip this to 'error' while we wait, which TS's
      // narrowing from the assignment above can't see.
      if ((live.session.status as LoginStatus) === 'error') return { ...live.session };
      await sleep(250);
    }
    this.fail(live, 'timed out waiting for an OAuth URL');
    return { ...live.session };
  }

  /**
   * Submit the code the user copied after authorising, and resolve once a token
   * has been captured (or the attempt fails).
   */
  async submitCode(code: string): Promise<LoginSession> {
    const live = this.live;
    // Structured so the UI can offer "start again" instead of surfacing a raw 400.
    // Reachable whenever the daemon restarted while the user was away authorising.
    if (!live) throw Object.assign(new Error('no login in progress'), { code: 'no_session' });
    if (live.session.status !== 'awaiting_code') {
      throw new Error(`login is ${live.session.status}, not awaiting a code`);
    }
    const trimmed = code.trim();
    if (!trimmed) throw new Error('code is required');

    live.session.status = 'exchanging';
    // Mark where the transcript is now, so the token regex can't match anything
    // echoed before this point (the pasted code itself is echoed back).
    const from = live.buf.length;
    live.proc.write(trimmed + '\r');

    const deadline = Date.now() + EXCHANGE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const token = extractToken(live.buf.slice(from));
      if (token) {
        this.saveToken(token);
        live.session.status = 'complete';
        live.session.url = null;
        try { live.proc.kill(); } catch { /* already gone */ }
        this.live = null;
        return { ...live.session };
      }
      // Cast: see start() — onExit can set 'error' asynchronously.
      if ((live.session.status as LoginStatus) === 'error') return { ...live.session };
      await sleep(250);
    }
    // A bare "timed out" tells the user nothing they can act on. Show what the CLI
    // last said — an invalid or already-used code says so explicitly.
    const detail = lastMeaningfulLine(live.buf.slice(from));
    this.fail(live, detail ? `Claude said: ${detail}` : 'timed out exchanging the code for a token');
    return { ...live.session };
  }

  /** Abandon any in-flight attempt. Safe to call when nothing is running. */
  cancel(): void {
    if (!this.live) return;
    try { this.live.proc.kill(); } catch { /* already gone */ }
    this.live = null;
  }

  private fail(live: Live, message: string): void {
    live.session.status = 'error';
    live.session.error = message;
    try { live.proc.kill(); } catch { /* already gone */ }
    if (this.live === live) this.live = null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
