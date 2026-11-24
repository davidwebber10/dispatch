import fs from 'fs';
import path from 'path';
import * as pty from 'node-pty';
import { v4 as uuid } from 'uuid';
import type { ClaudeCliLogin, ClaudeAuthStatus } from './claude-cli-login.js';
import { prepareAccountConfigDir } from './claude-config-dirs.js';

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
 * `setup-token` makes two links. It opens one in a browser by itself: that one redirects to
 * localhost, so Claude shows no code, and the user is left with nothing to paste. It prints the
 * other, which shows the code. `BROWSER=true` (spawn env below) stops the first, so the printed
 * link is the only one. Should a CLI ever finish without a code anyway, the watch in
 * startLogin keeps the token it prints.
 *
 * The resulting token is written 0600 into the daemon's own data dir and injected
 * as CLAUDE_CODE_OAUTH_TOKEN at spawn. It never leaves the box, which is what makes
 * it equivalent in risk to the `.credentials.json` a normal login would write.
 */

export type LoginStatus = 'starting' | 'awaiting_code' | 'exchanging' | 'complete' | 'error';

/** The account a finished sign-in landed in. */
export interface LoginAccount { id: string; label: string; isDefault: boolean }

export interface LoginSession {
  id: string;
  status: LoginStatus;
  /** The OAuth URL to open in a browser. Present once status is awaiting_code. */
  url: string | null;
  error: string | null;
  createdAt: string;
  /**
   * The account that got the token, once the login is complete (spec 2026-11-23): every sign-in
   * lands in an account. `isDefault: false` lets the page ask before the default changes.
   */
  account?: { id: string; label: string; isDefault: boolean };
  /**
   * For a sign-in with no account of its own (the generic card): where the token will land, known
   * from the start. `new`: a new token account, so the page explains what such a login lacks.
   */
  landsIn?: { kind: 'new' | 'existing'; label: string };
}

/** Claude's OAuth tokens are `sk-ant-oat01-…`; captured from setup-token's output. */
const TOKEN_RE = /\b(sk-ant-oat[0-9]{2}-[A-Za-z0-9_-]+)\b/;
const URL_RE = /https:\/\/claude\.com\/[^\s"'\x07\x1b]+/;
const START_TIMEOUT_MS = 45_000;
const EXCHANGE_TIMEOUT_MS = 45_000;
/** Gap between typing the code and pressing Enter, so the two aren't one paste burst. */
const SUBMIT_KEYPRESS_DELAY_MS = 250;
/** How often a login waiting for a code looks for a token the CLI printed by itself. */
const TOKEN_WATCH_MS = 250;

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
 * Like extractUrl, but only a link that has something after it (a line break, a space, an escape): a link
 * at the very end of the output can be half of a split chunk. `not`: a link that is already known (the dead
 * one), left out BEFORE the longest is chosen, so it cannot hide a new link of the same length or shorter.
 */
function completeUrl(raw: string, not?: string | null): string | null {
  const matches = (raw.match(new RegExp(URL_RE.source + '(?=[\\s"\'\\x07\\x1b])', 'g')) ?? []).filter((m) => m !== not);
  if (!matches.length) return null;
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

/**
 * The CLI's own error for a rejected code, if it has printed one.
 *
 * `setup-token` answers a bad code within a second or two and then offers a retry,
 * so waiting out the full exchange timeout turns an instant, actionable message
 * ("Invalid code. Please make sure the full code was copied") into a useless
 * 45-second "timed out".
 */
export function extractCliError(raw: string): string | null {
  // The CLI puts a mark (a cross or a spinner glyph) and a bare carriage return in front of the
  // words ("\r✘OAuth error: ..."), so the line cannot be required to START with them. Anything that
  // is not a letter or a digit may come first; a longer word ("TypeError:") may not.
  const m = stripAnsi(raw).match(/^[^A-Za-z0-9\n]*(OAuth error:[^\r\n]*|Error:[^\r\n]*)/m);
  return m ? m[1].trim().slice(0, 300) : null;
}

/** Last non-empty line of CLI output — the real reason when something fails. */
export function lastMeaningfulLine(raw: string): string | null {
  const lines = stripAnsi(raw)
    .split(/\r?\n/)
    .map((l) => l.trim())
    // Drop pure decoration AND the masked echo of the code the user just pasted,
    // which is a long run of asterisks and is never the reason for a failure.
    .filter((l) => l && !/^[\s\u2500-\u257F\u2800-\u28FF*·✢✻✽]+$/.test(l) && !/^\**$/.test(l.replace(/[^\x20-\x7e]/g, '')) && !/^press\s*enter/i.test(l));
  return lines.length ? lines[lines.length - 1].slice(0, 200) : null;
}

interface Live {
  session: LoginSession;
  proc: pty.IPty;
  buf: string;
  /** Where a token can start: after the login link, then after the last code submitted. */
  scanFrom: number;
  /** Where this attempt's token goes: an account of this label, or null for the single saved login. */
  accountLabel: string | null;
  /** "Sign in again" (W1-H): the saved account whose token this attempt replaces, or null for a new account. */
  accountId: string | null;
  watch: ReturnType<typeof setInterval>;
  /** Set once a token is being kept, so that only one path can keep it. */
  saving: Promise<void> | null;
  /** After a refused code: where the CLI's retry output starts, until its new link has been taken. */
  retryFrom?: number;
}

export class ClaudeLoginService {
  private live: Live | null = null;
  /** The last attempt that ended with a token, for a screen that polls status(). Holds no token. */
  private finished: LoginSession | null = null;
  private onChangeCb: (() => void) | null = null;
  private readonly tokenPath: string;

  constructor(
    private readonly dataDir: string,
    private readonly spawnPty: typeof pty.spawn = pty.spawn,
    /** How long a rejected code waits for the CLI's new link (a test shortens it). */
    private readonly retryLinkWaitMs: number = 8_000,
  ) {
    this.tokenPath = path.join(dataDir, 'claude-oauth-token');
  }

  onChange(cb: () => void): void { this.onChangeCb = cb; }

  // --- the clean login (hosted boxes; auth/claude-cli-login.ts) ------------
  /**
   * Set on a hosted box (or with DISPATCH_CLAUDE_LOGIN=cli): every login runs `claude auth login`,
   * Claude Code keeps its own credential, and this service holds, reads and injects NO token. The
   * setup-token path below is then never used. Unset: a local install, exactly as before.
   */
  private clean: { login: ClaudeCliLogin; ownerEmail: string | null } | null = null;
  /** A hosted added account signed in (its own config dir). The daemon adds or updates the account. */
  onAccountConfigDir: ((info: { id: string; label: string; configDir: string; status: ClaudeAuthStatus }) => void | Promise<void>) | null = null;

  /** A sign-in with `claude auth login` ended signed in: an account folder is reported, then every listener. */
  private readonly accountSignedIn = async ({ configDir, tag, status }: { configDir: string | null; tag: unknown; status: ClaudeAuthStatus }): Promise<void> => {
    const t = tag as { kind: 'primary' } | { kind: 'account'; id: string; label: string } | null;
    // A sign-in for a new account that was cancelled or replaced while Claude Code confirmed it (a
    // local install): its folder is already gone, so there is no account. Claude Code wrote the login
    // all the same, on macOS into the keychain: sign that folder out, then remove what it made again.
    // The rule is about the folder, not about one remembered attempt: a completion whose folder was
    // dropped, or is simply not there, never makes an account (review round 2: with three attempts a
    // single remembered folder was overwritten). The sign-out uses the engine that made the login.
    if (!this.clean && configDir && (this.droppedFolders.has(configDir) || !fs.existsSync(configDir))) {
      this.droppedFolders.delete(configDir);
      const engine = this.droppedEngines.get(configDir) ?? this.folder;
      this.droppedEngines.delete(configDir);
      await engine?.logout(configDir).catch(() => undefined);
      this.removeAttemptFolder(configDir);
      return;
    }
    // The account exists now: its folder is no longer the folder of an attempt.
    if (configDir && configDir === this.newFolder) this.newFolder = null;
    if (t && t.kind === 'account' && configDir) await this.onAccountConfigDir?.({ id: t.id, label: t.label, configDir, status });
    this.onChangeCb?.();
  };

  useCleanLogin(login: ClaudeCliLogin, opts: { ownerEmail?: string | null } = {}): void {
    this.clean = { login, ownerEmail: opts.ownerEmail?.trim() || null };
    login.onLoggedIn = this.accountSignedIn;
    // After the build: the env provider can name services that do not exist yet (found in a box run).
    setImmediate(() => { void login.authStatus().then(() => this.onChangeCb?.()); });
  }

  get usesCleanLogin(): boolean { return this.clean !== null; }

  // --- a full sign-in for ONE account on a local install (spec 2026-11-24) ---
  /**
   * A local install keeps `claude setup-token` for its ordinary sign-ins. An account can instead be
   * signed in with Claude Code's own `claude auth login` in a folder of its own, as on a hosted box:
   * that login keeps the claude.ai connectors of the account, which a setup-token token cannot fetch.
   * Dispatch holds no token for such an account.
   */
  private folder: ClaudeCliLogin | null = null;
  /** The attempt in flight, or the last one, is a folder sign-in: its status, its code and a cancel go there. */
  private folderTurn = false;
  /** The folder made for a NEW account by the attempt in flight. It is deleted when the attempt ends with no account. */
  private newFolder: string | null = null;
  /**
   * Every such folder that was deleted, with the engine of its attempt: a completion that arrives for
   * one of them afterwards is undone, not saved. An entry goes when its completion came; the newest
   * 64 are kept, far more than the attempts that can still be confirming.
   */
  private droppedFolders = new Set<string>();
  private droppedEngines = new Map<string, ClaudeCliLogin>();

  useFolderLogin(login: ClaudeCliLogin): void {
    this.folder = login;
    login.onLoggedIn = this.accountSignedIn;
  }

  /** This install can sign an account in with a folder of its own, next to the token sign-in. */
  get offersFolderLogin(): boolean { return this.clean === null && this.folder !== null; }

  private endFolderTurn(): void {
    if (!this.folderTurn) return;
    this.folderTurn = false;
    this.folder?.cancel();
    this.dropNewFolder();
  }

  /** The attempt for a new account ended with no account: its folder goes. Only a folder under `claude-accounts`. */
  private dropNewFolder(): void {
    const dir = this.newFolder;
    this.newFolder = null;
    if (!dir) return;
    this.droppedFolders.add(dir);
    if (this.folder) this.droppedEngines.set(dir, this.folder);
    for (const old of this.droppedFolders) { if (this.droppedFolders.size <= 64) break; this.droppedFolders.delete(old); this.droppedEngines.delete(old); }
    this.removeAttemptFolder(dir);
  }

  private removeAttemptFolder(dir: string): void {
    if (path.basename(path.dirname(dir)) !== 'claude-accounts') return;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* an empty folder that stays is harmless */ }
  }

  /**
   * A step of a folder attempt answered. An attempt that ended in an error leaves no folder for a
   * new account. `mine` is the folder of THAT attempt: an answer that comes after another attempt
   * took over must not delete the other attempt's folder (review of #193).
   */
  private afterFolderStep(session: LoginSession, mine: string | null): LoginSession {
    if (session.status === 'error' && mine !== null && this.newFolder === mine) this.dropNewFolder();
    return session;
  }

  /**
   * Sign an account folder out with Claude Code's own command, before the folder is deleted: on macOS
   * the credential is in the keychain, not in the folder. The clean login keeps its own way (the
   * credential is a file in the folder).
   */
  async signOutAccountFolder(configDir: string): Promise<void> {
    if (this.clean || !this.folder) return;
    await this.folder.logout(configDir);
    // The sign-out command hides its own failure. Ask: a folder that is still signed in keeps its
    // account, so the person can try again. No answer at all means Claude Code cannot be run, and
    // then nothing can be signed out: the removal goes on.
    const st = await this.folder.authStatus(configDir, { fresh: true });
    if (st?.loggedIn === true) throw new Error('Claude Code could not sign this account out. Try again, or run `claude auth logout` for it in a terminal.');
  }

  /**
   * `claude auth status`, cached briefly. The clean login: the primary login, or an account folder.
   * A local install: an account folder only (the login of the computer has its own check, setup/detect.ts).
   */
  async cliStatus(o: { fresh?: boolean; configDir?: string | null } = {}): Promise<ClaudeAuthStatus | null> {
    if (this.clean) return this.clean.login.authStatus(o.configDir ?? null, o);
    if (o.configDir && this.folder) return this.folder.authStatus(o.configDir, o);
    return null;
  }

  /** A thread reported an auth error: ask Claude Code again at the next read (clean login only). */
  noteAuthFailure(): void {
    if (!this.clean) return;
    this.clean.login.invalidate(null);
    void this.clean.login.authStatus(null, { fresh: true }).then(() => this.onChangeCb?.());
  }
  /** A login started with `startForAccount` hands its token here instead of the single saved file (multi-account). The login is complete when this settles. */
  onAccountToken: ((token: string, label: string, accountId?: string) => LoginAccount | void | Promise<LoginAccount | void>) | null = null;
  /**
   * Where a sign-in with no account of its own goes (the generic card): the label of a new
   * account, or with `accountId` the account whose token is replaced. The daemon wires it
   * (daemon/build.ts): the default account when that is a token account, else a new account.
   * Not wired (a unit test of this class alone): the old single file, as before.
   */
  genericTarget: (() => { label: string; accountId?: string } | null) | null = null;

  // --- token storage ------------------------------------------------------
  getToken(): string | null {
    if (this.clean) return null; // the clean login never reads a credential
    try {
      const v = fs.readFileSync(this.tokenPath, 'utf8').trim();
      return v || null;
    } catch { return null; }
  }

  isAuthenticated(): boolean {
    if (this.clean) {
      // Sync callers get the cached `claude auth status`; a stale cache is refreshed behind them.
      void this.clean.login.authStatus();
      return this.clean.login.cachedStatus()?.loggedIn === true;
    }
    return this.getToken() !== null;
  }

  private saveToken(token: string): void {
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(this.tokenPath, token, { mode: 0o600 });
    try { fs.chmodSync(this.tokenPath, 0o600); } catch { /* best effort */ }
    this.onChangeCb?.();
  }

  /**
   * Forget the stored token (sign out). On a hosted box (the clean login) `claude auth logout` runs as the
   * agent; the promise ends when it did, so the answer can say the new state.
   */
  signOut(): Promise<void> {
    if (this.clean) return this.clean.login.logout().then(() => this.onChangeCb?.());
    try { fs.rmSync(this.tokenPath, { force: true }); } catch { /* ignore */ }
    this.onChangeCb?.();
    return Promise.resolve();
  }

  /**
   * Forget the single saved login of earlier versions: its account (`saved`) was removed. Without
   * this the token file stays, and the next start makes the account again (issue 185). The clean
   * login has no saved token. Throws when the file cannot be deleted.
   */
  forgetSavedToken(): void {
    if (this.clean) return;
    // `force`: a file that is already gone is fine. Any other failure reaches the caller: a token
    // that stays on disk would still reach processes and bring the account back at the next start.
    fs.rmSync(this.tokenPath, { force: true });
    this.onChangeCb?.();
  }

  // --- login flow ---------------------------------------------------------
  status(): LoginSession | null {
    if (this.clean) return this.clean.login.status();
    if (this.folderTurn && this.folder) {
      // An attempt that ended by itself (a timeout, a CLI that exited) is seen here by the page's poll.
      const s = this.folder.status();
      return s ? this.afterFolderStep(s, this.newFolder) : null;
    }
    const session = this.live?.session ?? this.finished;
    return session ? { ...session } : null;
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
    if (this.clean) return this.clean.login.start({ email: this.clean.ownerEmail, tag: PRIMARY_TAG });
    this.endFolderTurn();
    const target = this.genericTarget?.() ?? null;
    return this.startLogin(target ? target.label : null, target?.accountId ?? null, target ? { kind: target.accountId ? 'existing' : 'new', label: target.label } : undefined);
  }

  /**
   * The same flow, but the captured token becomes a NEW account with this label (onAccountToken),
   * or, with `accountId`, replaces the token of that saved account ("Sign in again").
   */
  async startForAccount(label: string, accountId?: string, dataDirForAccounts?: string, opts: { /** A full sign-in in a folder of the account (a local install; the clean login always is one). */ folder?: boolean } = {}): Promise<LoginSession> {
    if (this.clean || opts.folder) {
      const login = this.clean?.login ?? this.folder;
      if (!login) throw new Error('This Dispatch cannot make a full sign-in. Update Dispatch, or use the sign-in that Dispatch keeps.');
      // One sign-in at a time: a token attempt that waits for its code ends here.
      if (!this.clean) this.cancelTokenAttempt();
      // The account's own config dir, shared parts linked to the primary (claude-config-dirs.ts).
      const id = accountId || uuid().slice(0, 8);
      const base = dataDirForAccounts ?? this.dataDir;
      const configDir = prepareAccountConfigDir(base, id);
      const tag = this.accountTag(id, label.trim() || 'Claude account');
      if (this.clean) return login.start({ configDir, tag });
      // A local install. One attempt at a time: the folder of an earlier attempt for a new account goes.
      if (configDir !== this.newFolder) this.dropNewFolder();
      this.folderTurn = true;
      if (!accountId) this.newFolder = configDir;
      return this.afterFolderStep(await login.start({ configDir, tag }), accountId ? null : configDir);
    }
    this.endFolderTurn();
    return this.startLogin(label.trim() || 'Claude account', accountId || null);
  }

  /** One tag object per account id, so a reload of the same login is the same attempt (ClaudeCliLogin.start). */
  private tags = new Map<string, { kind: 'account'; id: string; label: string }>();
  private accountTag(id: string, label: string) {
    const t = this.tags.get(id);
    if (t && t.label === label) return t;
    const n = { kind: 'account' as const, id, label };
    this.tags.set(id, n);
    return n;
  }

  /** A waiting attempt is reused only for the same destination; a token must not change owner. */
  private async startLogin(accountLabel: string | null, accountId: string | null, landsIn?: LoginSession['landsIn']): Promise<LoginSession> {
    // An attempt that is storing its token finishes first, so an old save cannot land after a new one.
    if (this.live?.saving) await this.live.saving;
    const pending = this.live;
    if (pending && pending.session.status === 'awaiting_code' && pending.session.url && pending.accountLabel === accountLabel && pending.accountId === accountId) {
      return { ...pending.session };
    }
    this.cancel();
    const session: LoginSession = {
      id: uuid(), status: 'starting', url: null, error: null,
      createdAt: new Date().toISOString(),
      ...(landsIn ? { landsIn } : {}),
    };
    const proc = this.spawnPty('claude', ['setup-token'], {
      // Wide enough that a ~100-character token never wraps (a 120-column terminal
      // broke it mid-string, which is how the exchange silently "timed out"), but
      // NOT enormous: at 4000 the CLI renders its masked input field to the full
      // width, producing a 4000-character row of asterisks that swamps the output.
      // extractToken() de-wraps defensively regardless.
      name: 'xterm-256color', cols: 220, rows: 40,
      cwd: this.dataDir,
      // Deliberately NOT inheriting an existing CLAUDE_CODE_OAUTH_TOKEN: re-authenticating
      // while a stale token is present makes the CLI skip the flow we're trying to run.
      // BROWSER=true: the CLI's own browser tab gives no code (see the top of this file).
      env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: '', BROWSER: 'true' } as Record<string, string>,
    });
    const live: Live = {
      session, proc, buf: '', scanFrom: 0, accountLabel, accountId, saving: null,
      watch: setInterval(() => this.adoptPrintedToken(live), TOKEN_WATCH_MS),
    };
    live.watch.unref?.();
    this.live = live;

    proc.onData((d) => { live.buf += d; });
    proc.onExit(() => {
      clearInterval(live.watch);
      const { status } = live.session;
      if (this.live !== live || status === 'complete' || status === 'error' || live.saving) return;
      // The token and the exit can arrive together, before anything has looked.
      const token = status === 'awaiting_code' || status === 'exchanging' ? extractToken(live.buf.slice(live.scanFrom)) : null;
      if (token) void this.finish(live, token);
      else this.fail(live, live.session.error ?? 'claude setup-token exited before completing'); // after a refused code: the CLI's own words
    });

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      // Cast: the onExit handler can flip this to 'error' while we wait, which TS's
      // narrowing from the assignment above can't see. Checked first: a link from a CLI
      // that has already exited is of no use.
      if ((live.session.status as LoginStatus) === 'error') return { ...live.session };
      const url = extractUrl(live.buf);
      if (url) {
        live.session.url = url;
        live.session.status = 'awaiting_code';
        live.scanFrom = live.buf.length;
        return { ...live.session };
      }
      await sleep(250);
    }
    this.fail(live, 'timed out waiting for an OAuth URL');
    return { ...live.session };
  }

  /**
   * Submit the code the user copied after authorising, and resolve once a token
   * has been captured (or the attempt fails).
   */
  async submitCode(code: string, attemptId?: string): Promise<LoginSession> {
    // A screen that still shows an attempt which another one replaced (a second tab): its code must
    // reach no sign-in at all. A page that sends no id (an older one) goes on as before.
    if (attemptId && this.status()?.id !== attemptId) throw Object.assign(new Error('no login in progress'), { code: 'no_session' });
    if (this.clean) return this.clean.login.submitCode(code);
    if (this.folderTurn && this.folder) {
      const mine = this.newFolder;
      return this.afterFolderStep(await this.folder.submitCode(code), mine);
    }
    const live = this.live;
    // Structured so the UI can offer "start again" instead of surfacing a raw 400.
    // Reachable whenever the daemon restarted while the user was away authorising.
    if (!live) throw Object.assign(new Error('no login in progress'), { code: 'no_session' });
    if (live.saving) {
      await live.saving;
      return { ...live.session };
    }
    if (live.session.status !== 'awaiting_code') {
      throw new Error(`login is ${live.session.status}, not awaiting a code`);
    }
    const trimmed = code.trim();
    if (!trimmed) throw new Error('code is required');

    // The CLI may have printed its token just before this code arrived.
    const printed = this.printedToken(live);
    if (printed) {
      await this.finish(live, printed);
      return { ...live.session };
    }

    live.session.status = 'exchanging';
    live.retryFrom = undefined; // a code is going in: the link on screen is the one it was made on
    // Mark where the transcript is now, so the token regex can't match anything
    // echoed before this point (the pasted code itself is echoed back).
    const from = live.buf.length;
    live.scanFrom = from;

    // Send the code and the Enter SEPARATELY.
    //
    // Claude Code's TUI is Ink-based and does bracketed-paste detection: a fast
    // burst of characters is treated as a paste, and a '\r' arriving inside that
    // same burst is absorbed as literal content rather than an Enter keypress. A
    // combined `code + '\r'` therefore fills the field and never submits — the CLI
    // sits at its prompt printing neither an error nor a token, which is precisely
    // how this failed: masked asterisks, no output, a full 45-second timeout.
    //
    // A short code doesn't trip paste detection, which is why a probe with a small
    // value appeared to work and a real ~100-character code did not.
    live.proc.write(trimmed);
    await sleep(SUBMIT_KEYPRESS_DELAY_MS);
    live.proc.write('\r');

    const deadline = Date.now() + EXCHANGE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      // Check for a rejection first — the CLI answers a bad code almost immediately,
      // and reporting that beats making the user wait out the timeout.
      const cliError = extractCliError(live.buf.slice(from));
      if (cliError) {
        // The CLI stays at its prompt ("Press Enter to retry"), so the session is still usable:
        // report its words and leave the attempt alive. Enter makes it start a fresh sign-in with a
        // fresh link (measured against the real CLI, 2026-11-21); a code from the old link can never
        // work, so the new link goes to the person with the error.
        await this.retryAfterRejection(live, cliError);
        return { ...live.session };
      }
      const token = extractToken(live.buf.slice(from));
      if (token) {
        await this.finish(live, token);
        return { ...live.session };
      }
      // Cast: see start() — onExit can set 'error' asynchronously.
      if ((live.session.status as LoginStatus) === 'error') return { ...live.session };
      await sleep(250);
    }
    // A bare "timed out" tells the user nothing they can act on. Show what the CLI
    // last said — an invalid or already-used code says so explicitly.
    const tail = live.buf.slice(from);
    const detail = lastMeaningfulLine(tail);
    // Log the raw tail: when the CLI prints neither a token nor an error, the only
    // way to tell what it was waiting for is to see exactly what it emitted.
    console.warn('claude setup-token exchange timed out. Output tail:',
      JSON.stringify(stripAnsi(tail).slice(-600)));
    this.fail(live, detail ? `Claude said: ${detail}` : 'timed out exchanging the code for a token');
    return { ...live.session };
  }

  /**
   * The CLI refused the code and waits at "Press Enter to retry". Press Enter, wait a moment for the
   * new link it prints, and leave the session waiting for a code with the CLI's own words as the error.
   * A link that comes later still replaces the old one (adoptPrintedToken looks for it while the session
   * waits). The CLI's output during the wait is kept for token capture, and a login that ended meanwhile
   * (a token saved, an exit) keeps its end state.
   */
  private async retryAfterRejection(live: Live, cliError: string): Promise<void> {
    live.session.error = cliError;
    const mark = live.buf.length;
    live.scanFrom = mark; // a token printed from here on is found by every path
    live.retryFrom = mark;
    try { live.proc.write('\r'); } catch { /* the CLI is gone: onExit ends the attempt */ }
    const deadline = Date.now() + this.retryLinkWaitMs;
    while (Date.now() < deadline && this.live === live && live.session.status === 'exchanging') {
      const token = extractToken(live.buf.slice(mark));
      if (token && !stripAnsi(live.buf.slice(mark)).endsWith(token)) { await this.finish(live, token); return; }
      // The old link printed again is not the new one: keep looking.
      const url = completeUrl(live.buf.slice(mark), live.session.url);
      if (url) { live.session.url = url; live.retryFrom = undefined; break; }
      await sleep(100);
    }
    if (live.session.status === 'exchanging' && !live.saving) live.session.status = 'awaiting_code';
  }

  /** Abandon any in-flight attempt. Safe to call when nothing is running. */
  cancel(): void {
    if (this.clean) { this.clean.login.cancel(); return; }
    this.endFolderTurn();
    this.cancelTokenAttempt();
  }

  /** End the `claude setup-token` attempt, when one is in flight, and forget the last one. */
  private cancelTokenAttempt(): void {
    this.finished = null;
    if (!this.live) return;
    clearInterval(this.live.watch);
    try { this.live.proc.kill(); } catch { /* already gone */ }
    this.live = null;
  }

  /**
   * A token the CLI printed while the login waited for a code, or null. A token at the very end
   * of the output can be half of a split chunk, so it must have something after it. (The CLI
   * prints more text after the token; a CLI that exits instead is handled by onExit.)
   */
  private printedToken(live: Live): string | null {
    const text = stripAnsi(live.buf.slice(live.scanFrom));
    const token = extractToken(text);
    return token && !text.endsWith(token) ? token : null;
  }

  private adoptPrintedToken(live: Live): void {
    if (this.live !== live || live.session.status !== 'awaiting_code') return;
    if (live.retryFrom !== undefined) {
      const url = completeUrl(live.buf.slice(live.retryFrom), live.session.url);
      if (url) { live.session.url = url; live.retryFrom = undefined; }
    }
    const token = this.printedToken(live);
    if (token) void this.finish(live, token);
  }

  /** Keep the token, one time, whichever path found it first. */
  private finish(live: Live, token: string): Promise<void> {
    return (live.saving ??= this.keep(live, token));
  }

  /** The login is complete only when the token is stored. Never rejects. */
  private async keep(live: Live, token: string): Promise<void> {
    clearInterval(live.watch);
    live.session.status = 'exchanging';
    try {
      if (live.accountLabel && this.onAccountToken) {
        const account = await this.onAccountToken(token, live.accountLabel, live.accountId ?? undefined);
        if (account) live.session.account = account;
      } else this.saveToken(token);
    } catch {
      this.fail(live, 'Dispatch could not save this login. Try again.');
      return;
    }
    live.session.status = 'complete';
    live.session.url = null;
    live.session.error = null;
    try { live.proc.kill(); } catch { /* already gone */ }
    if (this.live === live) {
      this.finished = live.session;
      this.live = null;
    }
  }

  private fail(live: Live, message: string): void {
    clearInterval(live.watch);
    live.session.status = 'error';
    live.session.error = message;
    try { live.proc.kill(); } catch { /* already gone */ }
    if (this.live === live) this.live = null;
  }
}

const PRIMARY_TAG = { kind: 'primary' as const };

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
