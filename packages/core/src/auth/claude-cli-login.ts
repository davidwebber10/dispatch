// packages/core/src/auth/claude-cli-login.ts
// The "clean" Claude login for a hosted box: Claude Code's own `claude auth login`, driven over
// plain pipes. The daemon never reads, parses or stores a token: Claude Code writes its own
// credential into its config dir ($CLAUDE_CONFIG_DIR, default ~/.claude), and the login state comes
// from `claude auth status` (a local check). Contrast auth/claude-login.ts (`claude setup-token`, a
// token the daemon keeps and injects), which stays the path of a local install.
//
// Measured on Claude Code 2.1.322 (2026-11-11), with plain pipes and no TTY:
//   `claude auth login --claudeai --email <addr>`
//     stdout: If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&…
//             &redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback…&login_hint=<addr>
//     stdout: Paste code here if prompted >
//     stdin : ONE line `code#state`
//       no `#`          → stderr "Invalid code. Please make sure the full code was copied." (keeps waiting)
//       wrong code#state → stderr "Login failed: That code wasn't accepted…", exit 1
//   With BROWSER set, Claude also hands that program a second URL whose redirect is
//   http://localhost:<port>/callback; it is useless off the box, so BROWSER is a no-op here.
//   The success text and the credential write were NOT seen end to end (it needs a real account):
//   success is "the process exited 0" and then `claude auth status` says loggedIn.
import { spawn as nodeSpawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { LoginSession, LoginStatus } from './claude-login.js';

export type SpawnFn = (cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv; cwd?: string }) => ChildProcessWithoutNullStreams;
export type ExecFn = (cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv; timeout: number }) => Promise<{ stdout: string; code: number }>;

/** What `claude auth status` says (JSON by default). Never a token. */
export interface ClaudeAuthStatus {
  loggedIn: boolean;
  authMethod?: string;
  email?: string;
  orgName?: string;
  subscriptionType?: string;
  planTier?: string;
  loginExpiresAt?: string;
}

/** The printed authorize URL. The localhost one (handed to BROWSER) is never it. */
const URL_RE = /https:\/\/claude\.(?:com|ai)\/[^\s"'<>]+/g;
export const INVALID_CODE_TEXT = 'Invalid code. Please make sure the full code was copied.';
export const LOGIN_FAILED_RE = /Login failed:([^\n]*)/;

/** The plain sentences a person reads. */
export const MSG = {
  noHash: 'That is not the whole code. Copy the full code from the Claude page (it has a # in the middle) and paste it again.',
  rejected: 'Claude did not accept that code. Start the sign-in again and use the new code.',
  timeout: 'The sign-in took too long and was stopped. Start it again.',
  noUrl: 'Claude did not give a sign-in link. Try again in a minute.',
  ended: 'The sign-in stopped before it finished. Start it again.',
  notSignedIn: 'Claude says this box is still not signed in. Start the sign-in again.',
} as const;

/** The authorize URL from the login's output, or null. Prefers the one that redirects to Claude's page (it shows the code). */
export function extractLoginUrl(text: string): string | null {
  const all = text.match(URL_RE) ?? [];
  const good = all.filter((u) => !/redirect_uri=http%3A%2F%2Flocalhost|redirect_uri=http:\/\/localhost/i.test(u));
  return good[0] ?? null;
}

/** `claude auth status` stdout → a status, or null when it is not the JSON we know. */
export function parseAuthStatus(stdout: string): ClaudeAuthStatus | null {
  const start = stdout.indexOf('{');
  if (start < 0) return null;
  try {
    const j = JSON.parse(stdout.slice(start));
    if (typeof j?.loggedIn !== 'boolean') return null;
    const pick = (k: string) => (typeof j[k] === 'string' && j[k] ? { [k]: j[k] } : {});
    return { loggedIn: j.loggedIn, ...pick('authMethod'), ...pick('email'), ...pick('orgName'), ...pick('subscriptionType'), ...pick('planTier'), ...pick('loginExpiresAt') };
  } catch { return null; }
}

/** A plan line for the page: "Max", "Pro"… from subscriptionType/planTier. */
export function planOf(s: ClaudeAuthStatus | null): string | null {
  const v = s?.planTier || s?.subscriptionType;
  return v ? v.charAt(0).toUpperCase() + v.slice(1) : null;
}

const defaultSpawn: SpawnFn = (cmd, args, opts) => nodeSpawn(cmd, args, { env: opts.env, cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
const defaultExec: ExecFn = (cmd, args, opts) => new Promise((resolve) => {
  execFile(cmd, args, { env: opts.env, timeout: opts.timeout, maxBuffer: 256 * 1024 }, (err, stdout) => {
    const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0;
    resolve({ stdout: String(stdout ?? ''), code });
  });
});

export interface ClaudeCliLoginOptions {
  /** The env the CLI runs with (PATH with the bundled tools). CLAUDE_CODE_OAUTH_TOKEN is always cleared. */
  env?: () => NodeJS.ProcessEnv;
  spawn?: SpawnFn;
  exec?: ExecFn;
  claudeBin?: string;
  startTimeoutMs?: number;
  exchangeTimeoutMs?: number;
  /** A login nobody finishes is stopped after this long (the child must not live forever). */
  sessionTimeoutMs?: number;
  /** How long a `claude auth status` answer is reused. */
  statusTtlMs?: number;
}

interface Live {
  session: LoginSession;
  child: ChildProcessWithoutNullStreams;
  out: string;
  err: string;
  /** Where this attempt's stderr was when the last code went in. */
  errFrom: number;
  exitCode: number | null;
  configDir: string | null;
  tag: unknown;
  timer: NodeJS.Timeout;
}

/** One login at a time, per daemon. `tag` says what the login is for (the primary, an added account). */
export class ClaudeCliLogin {
  private live: Live | null = null;
  private finished: LoginSession | null = null;
  private statusCache = new Map<string, { at: number; status: ClaudeAuthStatus | null }>();
  private readonly spawnFn: SpawnFn;
  private readonly execFn: ExecFn;
  private readonly bin: string;
  private readonly startTimeoutMs: number;
  private readonly exchangeTimeoutMs: number;
  private readonly sessionTimeoutMs: number;
  private readonly statusTtlMs: number;
  /** Called when a login ended signed in (after `claude auth status` agreed). */
  onLoggedIn: ((info: { configDir: string | null; tag: unknown; status: ClaudeAuthStatus }) => void | Promise<void>) | null = null;

  constructor(private readonly opts: ClaudeCliLoginOptions = {}) {
    this.spawnFn = opts.spawn ?? defaultSpawn;
    this.execFn = opts.exec ?? defaultExec;
    this.bin = opts.claudeBin ?? 'claude';
    this.startTimeoutMs = opts.startTimeoutMs ?? 45_000;
    this.exchangeTimeoutMs = opts.exchangeTimeoutMs ?? 60_000;
    this.sessionTimeoutMs = opts.sessionTimeoutMs ?? 15 * 60_000;
    this.statusTtlMs = opts.statusTtlMs ?? 30_000;
  }

  private env(configDir: string | null): NodeJS.ProcessEnv {
    let provided: NodeJS.ProcessEnv | undefined;
    try { provided = this.opts.env?.(); } catch { provided = undefined; } // a provider not wired yet: the daemon's env
    const base = { ...(provided ?? process.env) };
    // Never a token: the CLI's own login is the point. BROWSER no-op: the localhost URL is useless here.
    base.CLAUDE_CODE_OAUTH_TOKEN = '';
    base.BROWSER = 'true';
    delete base.ANTHROPIC_API_KEY;
    if (configDir) base.CLAUDE_CONFIG_DIR = configDir;
    return base;
  }

  status(): LoginSession | null {
    const s = this.live?.session ?? this.finished;
    return s ? { ...s } : null;
  }

  /** The login in flight is for this tag. */
  activeTag(): unknown { return this.live?.tag; }

  /**
   * Start `claude auth login --claudeai [--email <addr>]` and resolve once it printed the sign-in
   * link. Idempotent for the same target: the person leaves the page to sign in, and a reload must not
   * kill the login they are in the middle of.
   */
  async start(target: { configDir?: string | null; email?: string | null; tag?: unknown } = {}): Promise<LoginSession> {
    const configDir = target.configDir ?? null;
    const p = this.live;
    if (p && p.session.status === 'awaiting_code' && p.configDir === configDir && p.tag === (target.tag ?? null)) return { ...p.session };
    this.cancel();
    const session: LoginSession = { id: randomUUID(), status: 'starting', url: null, error: null, createdAt: new Date().toISOString() };
    const args = ['auth', 'login', '--claudeai', ...(target.email ? ['--email', target.email] : [])];
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnFn(this.bin, args, { env: this.env(configDir) });
    } catch (err) {
      session.status = 'error';
      session.error = `Could not start Claude Code: ${(err as Error)?.message ?? err}`;
      this.finished = session;
      return { ...session };
    }
    const live: Live = {
      session, child, out: '', err: '', errFrom: 0, exitCode: null, configDir, tag: target.tag ?? null,
      timer: setTimeout(() => this.fail(live, MSG.timeout), this.sessionTimeoutMs),
    };
    live.timer.unref?.();
    this.live = live;
    child.stdout.on('data', (d: Buffer) => { live.out += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { live.err += d.toString(); });
    child.on('error', (e) => this.fail(live, `Could not start Claude Code: ${e.message}`));
    child.on('exit', (code) => {
      live.exitCode = code ?? 1;
      if (this.live !== live) return;
      const st = live.session.status;
      // An exit while a code is being checked is read by submitCode; any other exit ends the attempt.
      if (st === 'starting' || st === 'awaiting_code') this.fail(live, this.failureText(live) ?? MSG.ended);
    });

    const deadline = Date.now() + this.startTimeoutMs;
    while (Date.now() < deadline) {
      if ((live.session.status as LoginStatus) === 'error') return { ...live.session };
      const url = extractLoginUrl(live.out) ?? extractLoginUrl(live.err);
      if (url) {
        live.session.url = url;
        live.session.status = 'awaiting_code';
        return { ...live.session };
      }
      await sleep(100);
    }
    this.fail(live, MSG.noUrl);
    return { ...live.session };
  }

  /** The person pasted `code#state`: write that one line, then wait for Claude's answer. */
  async submitCode(raw: string): Promise<LoginSession> {
    const live = this.live;
    if (!live) throw Object.assign(new Error('no login in progress'), { code: 'no_session' });
    if (live.session.status !== 'awaiting_code') throw new Error(`login is ${live.session.status}, not awaiting a code`);
    const code = raw.trim().replace(/\s+/g, '');
    if (!code) throw new Error('code is required');
    if (!code.includes('#')) {
      // Claude would answer INVALID_CODE_TEXT and keep waiting; say it in plain words without a round trip.
      live.session.error = MSG.noHash;
      return { ...live.session };
    }
    live.session.status = 'exchanging';
    live.session.error = null;
    live.errFrom = live.err.length;
    try { live.child.stdin.write(code + '\n'); } catch { this.fail(live, MSG.ended); return { ...live.session }; }

    const deadline = Date.now() + this.exchangeTimeoutMs;
    while (Date.now() < deadline) {
      if (this.live !== live) return { ...live.session };
      const fresh = live.err.slice(live.errFrom);
      if (fresh.includes(INVALID_CODE_TEXT)) {
        live.session.status = 'awaiting_code';
        live.session.error = MSG.noHash;
        live.errFrom = live.err.length;
        return { ...live.session };
      }
      if (live.exitCode !== null) {
        if (live.exitCode === 0) return this.confirm(live);
        this.fail(live, this.failureText(live) ?? MSG.rejected);
        return { ...live.session };
      }
      await sleep(100);
    }
    this.fail(live, MSG.timeout);
    return { ...live.session };
  }

  /** Exit 0: ask Claude Code whether the box is now signed in. The daemon reads no credential. */
  private async confirm(live: Live): Promise<LoginSession> {
    this.statusCache.delete(live.configDir ?? '');
    const st = await this.authStatus(live.configDir, { fresh: true });
    if (!st?.loggedIn) {
      this.fail(live, MSG.notSignedIn);
      return { ...live.session };
    }
    clearTimeout(live.timer);
    live.session.status = 'complete';
    live.session.url = null;
    live.session.error = null;
    if (this.live === live) { this.finished = live.session; this.live = null; }
    try { await this.onLoggedIn?.({ configDir: live.configDir, tag: live.tag, status: st }); } catch { /* the login itself is done */ }
    return { ...live.session };
  }

  private failureText(live: Live): string | null {
    const m = LOGIN_FAILED_RE.exec(live.err.slice(live.errFrom)) ?? LOGIN_FAILED_RE.exec(live.err);
    return m ? MSG.rejected : null;
  }

  cancel(): void {
    this.finished = null;
    const live = this.live;
    if (!live) return;
    clearTimeout(live.timer);
    this.live = null;
    try { live.child.kill('SIGTERM'); } catch { /* gone */ }
  }

  private fail(live: Live, message: string): void {
    clearTimeout(live.timer);
    live.session.status = 'error';
    live.session.error = message;
    live.session.url = null;
    if (live.exitCode === null) { try { live.child.kill('SIGTERM'); } catch { /* gone */ } }
    if (this.live === live) { this.finished = live.session; this.live = null; }
  }

  /**
   * `claude auth status` for a config dir (null: the default one), cached briefly. Null when the CLI
   * could not answer (not installed, or an answer we do not know). It is a local check.
   */
  async authStatus(configDir: string | null = null, o: { fresh?: boolean } = {}): Promise<ClaudeAuthStatus | null> {
    const key = configDir ?? '';
    const hit = this.statusCache.get(key);
    if (!o.fresh && hit && Date.now() - hit.at < this.statusTtlMs) return hit.status;
    const r = await this.execFn(this.bin, ['auth', 'status'], { env: this.env(configDir), timeout: 10_000 }).catch(() => ({ stdout: '', code: 1 }));
    const status = parseAuthStatus(r.stdout);
    this.statusCache.set(key, { at: Date.now(), status });
    return status;
  }

  /** The last cached answer, without asking (sync callers: the heartbeat, the spawn path). */
  cachedStatus(configDir: string | null = null): ClaudeAuthStatus | null {
    return this.statusCache.get(configDir ?? '')?.status ?? null;
  }

  /** Forget the cached status (after an auth error in a thread, so the next read asks again). */
  invalidate(configDir: string | null = null): void { this.statusCache.delete(configDir ?? ''); }

  /** Sign out with Claude Code's own command (it removes its own credential). */
  async logout(configDir: string | null = null): Promise<void> {
    await this.execFn(this.bin, ['auth', 'logout'], { env: this.env(configDir), timeout: 15_000 }).catch(() => undefined);
    this.statusCache.delete(configDir ?? '');
  }
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
