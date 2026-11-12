import type { Response, Router } from 'express';
import { policyRouter } from '../auth/route-policy.js';
import type { ClaudeLoginService } from '../auth/claude-login.js';
import type { CodexLoginService } from '../auth/codex-login.js';
import { ACCOUNT_PROVIDERS, type AccountProvider, type AccountsStore } from '../auth/accounts.js';
import { clientMessage } from '../http/client-message.js';
import { nextReadAfter, type UsageReadResult } from '../limits/claude-usage.js';

/** A thread pinned to an account, as the delete notice lists it. */
export interface PinnedThread { id: string; label: string; sessionId: string }
export interface AccountsRouteExtras {
  /** The Claude profile (email, plan) behind an account's token; null when it cannot be read. */
  claudeProfile?: (accountId: string) => Promise<{ email?: string; plan?: string } | null>;
  threads?: {
    pinnedTo: (provider: AccountProvider, accountId: string) => PinnedThread[];
    /** Drop the pin from every thread of the account; returns how many. They use the default next start. */
    unpin: (provider: AccountProvider, accountId: string) => number;
  };
  /** The device-code sign-in for an added Codex account (2026-11-07). Absent: those routes answer 501. */
  codexLogin?: Pick<CodexLoginService, 'start' | 'status' | 'cancel'>;
  /** The clock (tests). */
  now?: () => number;
}
const PROFILE_TTL_MS = 10 * 60_000;
const PROFILE_WAIT_MS = 3_000;

const isProvider = (v: unknown): v is AccountProvider => typeof v === 'string' && (ACCOUNT_PROVIDERS as readonly string[]).includes(v);

/**
 * Accounts per harness (docs/superpowers/specs/2026-11-06-multi-account-design.md). Owner only
 * (policyRouter's default): a thread key may not list or change logins.
 *
 *   GET    /api/accounts                      every account, no tokens
 *   POST   /api/accounts/claude/login { label, accountId? } start the headless login for a NEW Claude
 *                                             account, or with `accountId` "Sign in again" for that saved
 *                                             account: its token is replaced in place
 *                                             (finish with POST /api/claude-auth/login/code)
 *   POST   /api/accounts/claude/:id/check     "Check again": read that account's usage and profile now
 *   POST   /api/accounts/codex { label }      a new Codex account folder (not signed in yet)
 *   POST   /api/accounts/codex/:id/login      sign it in (or again): `codex login --device-auth`
 *                                             in its folder; answers the link and one-time code
 *   GET    /api/accounts/codex/:id/login      that attempt (poll); idle/complete when none runs
 *   DELETE /api/accounts/codex/:id/login      abandon the attempt
 *   PUT    /api/accounts/:provider/default { id }
 *   DELETE /api/accounts/:provider/:id
 */
export function createAccountsRouter(accounts: AccountsStore, claudeLogin: ClaudeLoginService, extras: AccountsRouteExtras = {}): Router {
  const router = policyRouter();
  // Claude profiles (email, plan) learned for the list, by account id: the CLI login's is never
  // stored, an added account's is written back. A miss waits before it is asked again (W1-H): the
  // same rule as the usage read (nextReadAfter), by what the gauge learned about the sign-in. A
  // refused sign-in (a `claude setup-token` token: 403 for scope) waits 6 hours, not 2 minutes;
  // any other miss 4, 8, 16 and at most 30 minutes. A new token or "Check again" asks at once.
  const now = extras.now ?? Date.now;
  const profiles = new Map<string, { at: number; p: { email?: string; plan?: string } | null; failures: number; retryAt: number; stamp: string | null }>();
  const missOf = (id: string): UsageReadResult => {
    const state = accounts.claudeUsageAccess(id)?.state;
    return state === 'sign-in-needed' || state === 'not-available' ? { ok: false, reason: 'forbidden' }
      : state === 'rate-limited' ? { ok: false, reason: 'rate-limited' } : { ok: false, reason: 'network' };
  };
  const claudeProfileOf = async (id: string) => {
    const hit = profiles.get(id);
    const stamp = accounts.claudeTokenStamp(id);
    const sameToken = !!hit && hit.stamp === stamp;
    if (hit && sameToken && (hit.p ? now() - hit.at < PROFILE_TTL_MS : now() < hit.retryAt)) return hit.p;
    const p = extras.claudeProfile ? await extras.claudeProfile(id).catch(() => null) : null;
    const at = now();
    const failures = p ? 0 : (hit && sameToken && !hit.p ? hit.failures : 0) + 1;
    profiles.set(id, { at, p, failures, retryAt: p ? at : nextReadAfter(missOf(id), failures, at), stamp });
    return p;
  };

  router.get('/', async (_req, res) => {
    const v = accounts.view();
    const count = (provider: AccountProvider, id: string) => (extras.threads ? { threadCount: extras.threads.pinnedTo(provider, id).length } : {});
    // Who each account is (2026-11-06): Codex from its login file; Claude from the profile call,
    // bounded so a slow network never holds the list.
    const codex = v.codex.map((a) => {
      const who = accounts.codexIdentity(a.id);
      return { ...a, ...(who?.email && !a.email ? { email: who.email } : {}), ...(who?.plan && !a.plan ? { plan: who.plan } : {}), signedIn: a.isCli ? undefined : accounts.codexSignedIn(a.id), ...count('codex', a.id) };
    });
    const claude = await Promise.all(v.claude.map(async (a) => {
      const need = !a.email || !a.plan;
      const p = need ? await Promise.race([claudeProfileOf(a.id), new Promise<null>((r) => setTimeout(() => r(null), PROFILE_WAIT_MS).unref?.())]) : null;
      return { ...a, ...(p?.email && !a.email ? { email: p.email } : {}), ...(p?.plan && !a.plan ? { plan: p.plan } : {}), ...count('claude', a.id) };
    }));
    res.json({ ...v, claude, codex });
  });

  router.patch('/:provider/:id', (req, res) => {
    const { provider, id } = req.params;
    if (!isProvider(provider)) return void res.status(404).json({ error: 'unknown provider' });
    const label = typeof req.body?.label === 'string' ? req.body.label : '';
    try {
      if (!accounts.has(provider, id)) return void res.status(404).json({ error: 'unknown account' });
      accounts.rename(provider, id, label);
      res.json(accounts.view());
    } catch (err) { res.status(400).json({ error: clientMessage(err) }); }
  });

  router.get('/:provider/:id/threads', (req, res) => {
    const { provider, id } = req.params;
    if (!isProvider(provider)) return void res.status(404).json({ error: 'unknown provider' });
    res.json(extras.threads?.pinnedTo(provider, id) ?? []);
  });

  router.post('/claude/login', async (req, res) => {
    const label = typeof req.body?.label === 'string' ? req.body.label : '';
    // "Sign in again" (W1-H): the login is for one saved account, whose token it replaces.
    const accountId = typeof req.body?.accountId === 'string' && req.body.accountId ? req.body.accountId : undefined;
    if (accountId === 'cli') return void res.status(400).json({ error: 'the CLI login is signed in on its own computer (claude)' });
    if (accountId && !accounts.has('claude', accountId)) return void res.status(404).json({ error: 'unknown account' });
    try { res.json(await (accountId ? claudeLogin.startForAccount(label, accountId) : claudeLogin.startForAccount(label))); } catch (err) { res.status(500).json({ error: clientMessage(err) }); }
  });

  // "Check again" (W1-H): forget the profile wait and ask the gauge for a usage read now.
  router.post('/claude/:id/check', (req, res) => {
    const { id } = req.params;
    if (!accounts.has('claude', id)) return void res.status(404).json({ error: 'unknown account' });
    profiles.delete(id);
    accounts.checkUsage(id);
    res.status(202).json({ ok: true });
  });

  router.post('/codex', (req, res) => {
    const label = typeof req.body?.label === 'string' ? req.body.label : '';
    const a = accounts.addCodex(label);
    res.status(201).json({ id: a.id, label: a.label });
  });

  // A Codex account signs in with the device-code flow, which works from any device: the
  // browser flow's callback goes to 127.0.0.1 on whichever machine opened the link
  // (see auth/codex-login.ts). This is also "Sign in again" for an account with no login.
  const codexAccount = (id: string, res: Response): string | null => {
    if (id === 'cli') { res.status(400).json({ error: 'the CLI login is signed in on its own computer (codex login)' }); return null; }
    const home = accounts.codexHome(id);
    if (!home) { res.status(404).json({ error: 'unknown account' }); return null; }
    if (!extras.codexLogin) { res.status(501).json({ error: 'this daemon cannot sign Codex accounts in' }); return null; }
    return home;
  };
  router.post('/codex/:id/login', async (req, res) => {
    const home = codexAccount(req.params.id, res);
    if (!home) return;
    try { res.json(await extras.codexLogin!.start(req.params.id, home)); } catch (err) { res.status(500).json({ error: clientMessage(err) }); }
  });
  router.get('/codex/:id/login', (req, res) => {
    const home = codexAccount(req.params.id, res);
    if (!home) return;
    const s = extras.codexLogin!.status(req.params.id);
    res.json(s ?? { accountId: req.params.id, status: accounts.codexSignedIn(req.params.id) ? 'complete' : 'idle', url: null, code: null, error: null, createdAt: null });
  });
  router.delete('/codex/:id/login', (req, res) => {
    if (!codexAccount(req.params.id, res)) return;
    extras.codexLogin!.cancel(req.params.id);
    res.status(204).end();
  });

  router.put('/:provider/default', (req, res) => {
    const { provider } = req.params;
    if (!isProvider(provider)) return void res.status(404).json({ error: 'unknown provider' });
    const id = typeof req.body?.id === 'string' ? req.body.id : '';
    try { accounts.setDefault(provider, id); res.json(accounts.view().defaults); } catch (err) { res.status(400).json({ error: clientMessage(err) }); }
  });

  router.delete('/:provider/:id', (req, res) => {
    const { provider, id } = req.params;
    if (!isProvider(provider)) return void res.status(404).json({ error: 'unknown provider' });
    try {
      if (!accounts.remove(provider, id)) return void res.status(404).json({ error: 'unknown account' });
      // Its threads lose the pin and run on the default from their next start (what the notice said).
      const unpinned = extras.threads?.unpin(provider, id) ?? 0;
      res.json({ unpinned });
    } catch (err) { res.status(400).json({ error: clientMessage(err) }); }
  });

  return router;
}
