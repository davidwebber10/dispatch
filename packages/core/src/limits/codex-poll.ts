// packages/core/src/limits/codex-poll.ts
// Codex's limits straight from Codex (2026-11-05). The session-file read (codex-refresh.ts) only
// knows the figures of a Codex thread that ran a turn lately, so Codex was missing from the usage
// sheet whenever no Codex thread had been busy. `codex app-server` answers
// `account/rateLimits/read` with the account's live windows and its banked reset credits, no turn
// needed: one short-lived process per request, signed in the way a thread is (the thread spawn env).
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { resolveBin, detectProvider } from '../setup/detect.js';
import { parseCodexRateLimits, type LimitSnapshots } from './snapshot.js';

const TIMEOUT_MS = 15_000;

/** The app-server's camelCase windows, renamed to the session file's snake_case for parseCodexRateLimits. */
export function toSessionShape(rl: any): unknown {
  if (!rl || typeof rl !== 'object') return null;
  const win = (w: any) => (w && typeof w === 'object' ? { used_percent: w.usedPercent, window_minutes: w.windowDurationMins, resets_at: w.resetsAt } : null);
  return { primary: win(rl.primary), secondary: win(rl.secondary), plan_type: typeof rl.planType === 'string' && rl.planType !== 'unknown' ? rl.planType : undefined };
}

/** One banked reset: its id (to spend that one), when it expires (ms, or null), and its title. */
export interface ResetCredit { id: string; expiresAt: number | null; title: string | null }
/** Banked limit resets the account can spend (Codex's "reset credits"), soonest-expiring first. */
export interface ResetCredits { available: number; nextExpiresAt: number | null; credits: ResetCredit[] }

/** The credits summary from an account/rateLimits/read answer, or null when it carried none. */
export function parseResetCredits(res: any): ResetCredits | null {
  const c = res?.rateLimitResetCredits;
  if (!c || typeof c !== 'object') return null;
  const available = Number(c.availableCount);
  if (!Number.isFinite(available)) return null;
  const credits: ResetCredit[] = (Array.isArray(c.credits) ? c.credits : [])
    .filter((x: any) => typeof x?.id === 'string' && (x.status === 'available' || x.status === undefined))
    .map((x: any) => ({ id: x.id, expiresAt: typeof x.expiresAt === 'number' ? x.expiresAt * 1000 : null, title: typeof x.title === 'string' ? x.title : null }))
    // Soonest to expire first; a credit that never expires goes last.
    .sort((a: ResetCredit, b: ResetCredit) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity));
  return { available, nextExpiresAt: credits.find((x) => x.expiresAt !== null)?.expiresAt ?? null, credits };
}

/** Run one request against a fresh `codex app-server`. Null on any failure (not installed, signed out, error, timeout). */
export function codexRequest(env: () => Record<string, string>, method: string, params?: unknown): Promise<any | null> {
  return (async () => {
    const bin = await resolveBin('codex');
    if (!bin) return null;
    if ((await detectProvider('codex').catch(() => null))?.signedIn === false) return null;
    return new Promise<any | null>((resolve) => {
      let done = false;
      let buf = '';
      const child = spawn(bin, ['app-server'], { env: env(), stdio: ['pipe', 'pipe', 'ignore'] });
      const finish = (v: any | null) => { if (done) return; done = true; clearTimeout(timer); try { child.kill(); } catch { /* gone */ } resolve(v); };
      const timer = setTimeout(() => finish(null), TIMEOUT_MS);
      timer.unref?.();
      const send = (m: unknown) => { try { child.stdin?.write(`${JSON.stringify(m)}\n`); } catch { finish(null); } };
      child.on('error', () => finish(null));
      child.on('close', () => finish(null));
      child.stdin?.on('error', () => finish(null));
      child.stdout?.on('data', (d) => {
        buf += d;
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          let m: any;
          try { m = JSON.parse(line); } catch { continue; }
          if (m?.id === 1) { send({ method: 'initialized' }); send(params === undefined ? { id: 2, method } : { id: 2, method, params }); }
          else if (m?.id === 2) finish(m.error ? null : m.result ?? null);
        }
      });
      send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'dispatch', version: '1' }, capabilities: null } });
    });
  })().catch(() => null);
}

export interface CodexPollDeps {
  snapshots: LimitSnapshots;
  accountFor: (provider: string) => string;
  /** The env a thread is spawned with, overlaid on the daemon's own. */
  env: () => Record<string, string>;
  now?: () => number;
  /** Injectable for tests: the app-server's `account/rateLimits/read` result, or null. */
  read?: () => Promise<any | null>;
  /** Injectable for tests: the `account/rateLimitResetCredit/consume` result, or null. */
  consume?: (idempotencyKey: string, creditId: string | null) => Promise<any | null>;
}

export interface CodexPoll {
  /** Read Codex's live limits and record them. True when figures were recorded. */
  (): Promise<boolean>;
  /** The banked resets from the last read; null until a read reported them. */
  credits(): ResetCredits | null;
  /**
   * Spend one banked reset, then read the limits again: `creditId`, or by default the one that
   * expires soonest (so none lapses unused). The backend's outcome, or null when it could not be asked.
   */
  useCredit(creditId?: string): Promise<string | null>;
}

export function createCodexPoll(d: CodexPollDeps): CodexPoll {
  const now = d.now ?? Date.now;
  const read = d.read ?? (() => codexRequest(d.env, 'account/rateLimits/read'));
  const consume = d.consume ?? ((idempotencyKey: string, creditId: string | null) => codexRequest(d.env, 'account/rateLimitResetCredit/consume', creditId ? { idempotencyKey, creditId } : { idempotencyKey }));
  let credits: ResetCredits | null = null;
  const poll = (async () => {
    const res = await read();
    if (res) credits = parseResetCredits(res) ?? credits;
    const rl = res?.rateLimitsByLimitId?.codex ?? res?.rateLimits;
    const { windows, plan } = parseCodexRateLimits(toSessionShape(rl));
    if (!Object.keys(windows).length) return false;
    d.snapshots.record('codex', d.accountFor('codex'), windows, now(), plan, true);
    return true;
  }) as CodexPoll;
  poll.credits = () => credits;
  poll.useCredit = async (creditId?: string) => {
    const pick = creditId ?? credits?.credits[0]?.id ?? null;
    const res = await consume(randomUUID(), pick);
    if (!res) return null;
    await poll();
    return typeof res.outcome === 'string' ? res.outcome : JSON.stringify(res.outcome ?? 'done');
  };
  return poll;
}
