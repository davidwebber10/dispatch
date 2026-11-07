import * as pty from 'node-pty';
import { lastMeaningfulLine, stripAnsi } from './claude-login.js';

/**
 * Sign an added Codex account in from any device (2026-11-07).
 *
 * Runs `codex login --device-auth` with CODEX_HOME set to the account's folder. The CLI prints a
 * link and a one-time code, then polls OpenAI until the code is approved and writes auth.json.
 *
 * Why the device-code flow and not `codex login`: the browser flow redirects to
 * `http://127.0.0.1:1455/auth/callback` (the CLI's server listens on 127.0.0.1 only). From a phone
 * or another computer that lands on the wrong machine, so the user had to copy the dead URL back
 * into Dispatch, which then had to replay it to the CLI within its lifetime and its 5-second
 * forward window. And codex-cli 0.167.0 answers a failed exchange with HTTP 200 and an error page,
 * which read as success: the banner closed and nothing was signed in. The device flow has no
 * callback at all: open a link anywhere, type the code, done. The daemon sees the result itself.
 */

export type CodexLoginStatus = 'starting' | 'awaiting_user' | 'complete' | 'error';

export interface CodexLoginSession {
  accountId: string;
  status: CodexLoginStatus;
  /** The page to open (https://auth.openai.com/codex/device). Present once awaiting_user. */
  url: string | null;
  /** The one-time code to type on that page. */
  code: string | null;
  error: string | null;
  createdAt: string;
}

const URL_RE = /https:\/\/[^\s"'\x1b\x07]+/;
/** The one-time code: letters and digits in two dash-joined groups, e.g. ABCD-12345. */
const CODE_RE = /\b([A-Z0-9]{4,}-[A-Z0-9]{4,})\b/;

/** The link and code from `codex login --device-auth` output, or null until both are there. */
export function parseDeviceAuth(raw: string): { url: string; code: string } | null {
  const text = stripAnsi(raw);
  const url = URL_RE.exec(text)?.[0];
  if (!url) return null;
  // The code comes after the link ("2. Enter this one-time code"): look only there, so nothing
  // in the banner above can pass for it.
  const after = text.slice(text.indexOf(url) + url.length);
  const code = CODE_RE.exec(after)?.[1];
  return code ? { url, code } : null;
}

interface Live { session: CodexLoginSession; proc: pty.IPty; buf: string }

export interface CodexLoginDeps {
  spawnPty?: typeof pty.spawn;
  /** The env the CLI runs with (the threads' spawn env: PATH with the bundled tools). CODEX_HOME is added. */
  env: () => Record<string, string | undefined>;
  /** Whether the folder now holds a login (auth.json). */
  isSignedIn: (codexHome: string) => boolean;
  startTimeoutMs?: number;
}

export class CodexLoginService {
  /** One attempt per account; a finished one stays readable until the next start. */
  private live = new Map<string, Live>();
  private readonly spawnPty: typeof pty.spawn;
  private readonly startTimeoutMs: number;

  constructor(private readonly deps: CodexLoginDeps) {
    this.spawnPty = deps.spawnPty ?? pty.spawn;
    this.startTimeoutMs = deps.startTimeoutMs ?? 45_000;
  }

  status(accountId: string): CodexLoginSession | null {
    const l = this.live.get(accountId);
    return l ? { ...l.session } : null;
  }

  /**
   * Start the device-code login for an account, and resolve once the link and code are known
   * (or the CLI failed). IDEMPOTENT while a code waits: the user leaves the page to type it, so
   * a refresh or a second tap must not throw that code away.
   */
  async start(accountId: string, codexHome: string): Promise<CodexLoginSession> {
    const pending = this.live.get(accountId);
    if (pending && pending.session.status === 'awaiting_user') return { ...pending.session };
    this.cancel(accountId);
    const session: CodexLoginSession = { accountId, status: 'starting', url: null, code: null, error: null, createdAt: new Date().toISOString() };
    const proc = this.spawnPty('codex', ['login', '--device-auth'], {
      name: 'xterm-256color', cols: 200, rows: 40, cwd: codexHome,
      env: { ...this.deps.env(), CODEX_HOME: codexHome } as Record<string, string>,
    });
    const live: Live = { session, proc, buf: '' };
    this.live.set(accountId, live);

    proc.onData((d) => {
      live.buf = (live.buf + d).slice(-16_000);
      if (live.session.status === 'starting') {
        const found = parseDeviceAuth(live.buf);
        if (found) Object.assign(live.session, { status: 'awaiting_user', url: found.url, code: found.code });
      }
    });
    proc.onExit(() => {
      if (this.live.get(accountId) !== live || live.session.status === 'complete' || live.session.status === 'error') return;
      if (this.deps.isSignedIn(codexHome)) {
        Object.assign(live.session, { status: 'complete', url: null, code: null, error: null });
      } else {
        const line = lastMeaningfulLine(live.buf);
        Object.assign(live.session, { status: 'error', error: line ? `Codex said: ${line}` : 'codex login exited before the sign-in finished' });
      }
    });

    const deadline = Date.now() + this.startTimeoutMs;
    while (Date.now() < deadline) {
      if (live.session.status !== 'starting') return { ...live.session };
      await new Promise((r) => setTimeout(r, 50));
    }
    Object.assign(live.session, { status: 'error', error: 'timed out waiting for Codex to show a sign-in code' });
    try { proc.kill(); } catch { /* already gone */ }
    return { ...live.session };
  }

  /** Abandon an account's attempt. Safe when nothing runs. */
  cancel(accountId: string): void {
    const l = this.live.get(accountId);
    if (!l) return;
    this.live.delete(accountId);
    try { l.proc.kill(); } catch { /* already gone */ }
  }
}
